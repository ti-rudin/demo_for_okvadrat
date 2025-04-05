const fs = require('fs');
const { performance } = require('perf_hooks');
const redis = require("redis");

// Конфигурация
const config = {
    producerCount: 10,    // Количество производителей
    rangeMax: 25        // Максимальное число в диапазоне [0 - N]
  };
  
class UniqueNumberProcessor {
  constructor(config) {
    this.config = config;
    this.client = redis.createClient({
      url: "redis://redis:6379",
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 100, 5000)
      }
    });
    
    this.client.auth("dfffgDFFGw44");
    this.client.on('error', (err) => console.error('Redis error:', err));
    
    this.streamKey = 'numbers_stream';
    this.consumerGroup = 'numbers_group';
    this.consumerName = `consumer_${process.pid}`;
    
    this.result = {
      timeSpent: 0,
      numbersGenerated: []
    };
    
    this.uniqueNumbers = new Set();
    this.startTime = 0;
    this.producers = [];
    this.shouldStop = false;
  }

  async initialize() {
    try {
      await new Promise((resolve, reject) => {
        this.client.send_command(
          'XGROUP', 
          ['CREATE', this.streamKey, this.consumerGroup, '0', 'MKSTREAM'],
          (err) => err && err.message.includes('BUSYGROUP') ? resolve() : err ? reject(err) : resolve()
        );
      });
    } catch (err) {
      console.error('Error initializing consumer group:', err);
      throw err;
    }
  }

  async startProducers() {
    this.startTime = performance.now();
    const numbersPerProducer = Math.ceil(this.config.rangeMax / this.config.producerCount);
    
    for (let i = 0; i < this.config.producerCount; i++) {
      const producer = async () => {
        try {
          let generated = 0;
          while (generated < numbersPerProducer && !this.shouldStop) {
            const num = Math.floor(Math.random() * (this.config.rangeMax + 1));
            await new Promise((resolve, reject) => {
              this.client.XADD(
                this.streamKey,
                '*',
                'number',
                num.toString(),
                (err) => err ? reject(err) : resolve()
              );
            });
            generated++;
          }
        } catch (err) {
          console.error('Producer error:', err);
        }
      };
      this.producers.push(producer());
    }
  }

  async processMessage(message) {
    const [id, fields] = message;
    const num = parseInt(fields[1]);
    
    if (!this.uniqueNumbers.has(num)) {
      this.uniqueNumbers.add(num);
      this.result.numbersGenerated.push(num);
      
      await new Promise((resolve, reject) => {
        this.client.XACK(this.streamKey, this.consumerGroup, id, (err) => 
          err ? reject(err) : resolve()
        );
      });
      
      return true;
    }
    return false;
  }

  async startConsumer() {
    while (!this.shouldStop && this.uniqueNumbers.size <= this.config.rangeMax) {
      try {
        const items = await new Promise((resolve, reject) => {
          this.client.send_command(
            'XREADGROUP',
            [
              'GROUP', this.consumerGroup, this.consumerName,
              'COUNT', 100, 'BLOCK', 1000,
              'STREAMS', this.streamKey, '>'
            ],
            (err, result) => err ? reject(err) : resolve(result)
          );
        });

        if (!items) {
          const allProducersDone = (await Promise.allSettled(this.producers))
            .every(p => p.status === 'fulfilled');
          if (allProducersDone) break;
          continue;
        }

        for (const message of items[0][1]) {
          await this.processMessage(message);
          if (this.uniqueNumbers.size > this.config.rangeMax) {
            this.shouldStop = true;
            break;
          }
        }
      } catch (err) {
        console.error('Consumer error:', err);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    this.result.timeSpent = performance.now() - this.startTime;
    await this.saveResults();
  }

  async saveResults() {
    try {
      const result = {
        timeSpent: Math.round(this.result.timeSpent),
        numbersGenerated: [...this.uniqueNumbers].sort((a, b) => a - b)
      };
      
      fs.writeFileSync('result.json', JSON.stringify(result, null, 2));
      console.log('Results saved to result.json');
    } catch (err) {
      console.error('Error saving results:', err);
      throw err;
    }
  }

  async cleanup() {
    try {
      await new Promise(resolve => this.client.quit(() => resolve()));
    } catch (err) {
      console.error('Cleanup error:', err);
    }
  }

  async run() {
    try {
      await this.initialize();
      await this.startProducers();
      await this.startConsumer();
    } finally {
      await this.cleanup();
    }
  }
}

// Graceful shutdown
const processor = new UniqueNumberProcessor(config);
process.on('SIGINT', () => {
  processor.shouldStop = true;
  setTimeout(() => process.exit(0), 1000);
});
process.on('SIGTERM', () => {
  processor.shouldStop = true;
  setTimeout(() => process.exit(0), 1000);
});

processor.run().catch(err => {
  console.error('Processor error:', err);
  process.exit(1);
});