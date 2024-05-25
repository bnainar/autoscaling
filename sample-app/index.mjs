import Redis from "ioredis";
import fastify from "fastify";
import { Queue, MetricsTime, Worker } from "bullmq";
import config from "config";
import process from "node:process"

console.log(JSON.parse(process.env.REDIS_NODES));

let clusterOpts = config.get("redis.bullmq.options");
// only for local development
if (process.env.LAPTOP) {
  clusterOpts = {
    ...clusterOpts,
    natMap: {
      "127.0.0.1:6375": { host: process.env.LAPTOP, port: 6375 },
      "127.0.0.1:6380": { host: process.env.LAPTOP, port: 6380 },
      "127.0.0.1:6381": { host: process.env.LAPTOP, port: 6381 },
    },
  };
  console.log({ natMap: clusterOpts.natMap });
}

const connection = new Redis.Cluster(
  JSON.parse(process.env.REDIS_NODES) ?? config.get("redis.bullmq.nodes"),
  clusterOpts
);

const bullmqWorkerOptions = {
  connection,
  prefix: process.env.BULLMQ_PREFIX ?? config.get("redis.bullmq.prefix"),
  metrics: {
    maxDataPoints: MetricsTime.ONE_WEEK * 2,
  },
  lockDuration: config.get("bullmq.lockDuration"),
  stalledInterval: config.get("bullmq.stalledInterval"),
};

async function jobProcessor() {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  await sleep(2000);
  console.log("processing job " + process.pid)
  return;
}

/**
 * @type {Object<string, Array<any>>}
 */
const workerInstances = {};

const queues = {};

const queueNames =
  process.env.QUEUE_NAMES?.split(",") ?? config.get("queueNames");

function initQueues() {
  queueNames.forEach((name) => {
    name = `{${name}}`
    const q = new Queue(name, bullmqWorkerOptions);
    queues[name] = q;
    workerInstances[name] = [
      new Worker(name, jobProcessor, bullmqWorkerOptions),
    ];
  });
}

initQueues();

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT ?? 3000);

const app = fastify({ logger: true });

app.get("/api/bullmq/:queueName/concurrency", async (request, res) => {
  const { queueName } = request.params;
  let ans = 0;
  workerInstances[queueName].forEach(curr => ans += curr.opts.concurrency)
  res.send(ans);
});

app.post("/api/bullmq/:queueName/concurrency", async (request, res) => {
  const { target } = request.body;
  const { queueName } = request.params;
  if (target === -1) {
    if (workerInstances[queueName].length === 0) {
      return res.code(400).send("No workers to close");
    }
    try {
      console.log("unregistering 1 processor");
      await workerInstances[queueName].pop().close();
      console.log("Removed worker");
      return res.send(
        `Workers count now: ${workerInstances[queueName].length}`
      );
    } catch (e) {
      console.log("Unable to remove worker", e);
      return res.code(500).send("Unable to remove worker");
    }
  } else {
    console.log("registering a processor");
    workerInstances[queueName].push(
      new Worker(queueName, jobProcessor, bullmqWorkerOptions)
    );
    return res.send(
      `Added a worker. Workers count now: ${workerInstances[queueName].length}`
    );
  }
});

app.post("/api/bullmq/:queueName/seed", async (request, res) => {
  const { target } = request.body;
  const { queueName } = request.params;
  for (let i = 0; i < target; i++) queues[queueName].add("yeah", {});
  res.send("seeded jobs " + target);
});

app.get("/status", (_, res) => {
  res.send("Alive");
});

app.get("/ready", (_, res) => {
  connection.status === "ready" ? res.code(200).send() : res.code(500).send();
});

app.get("/api/bullmq/:queueName/status", async (request, res) => {
  const { queueName } = request.params;
  const q = queues[queueName];
  const x = await Promise.all([q.getWaitingCount(), q.getActiveCount(), q.getWorkersCount()])
  res.send(x);
});

await app.listen({ host: HOST, port: PORT });
