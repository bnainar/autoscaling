import config from "config";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { app } from "./fastify.mjs";

let clusterOpts = config.get("redis.options");
// only for local development
if (config.has("laptop")) {
  clusterOpts = {
    natMap: {
      "127.0.0.1:6375": { host: config.get("laptop"), port: 6375 },
      "127.0.0.1:6380": { host: config.get("laptop"), port: 6380 },
      "127.0.0.1:6381": { host: config.get("laptop"), port: 6381 },
    },
  };
  console.log({ natMap: clusterOpts.natMap });
}

const connection = new Redis.Cluster(config.get("redis.nodes"), clusterOpts);
const bullmqWorkerOptions = {
  connection,
  prefix: config.get("redis.prefix"),
};

export const aggregation_queue = new Queue(
  "{aggregation}",
  bullmqWorkerOptions
);
const worker = new Worker(
  "{aggregation}",
  ({ data }) => data,
  bullmqWorkerOptions
);

worker.on("failed", (job, err) => {
  console.error(`Job ${job.id} failed: ${err.message}`);
});

function getPriority() {
  return 1;
}

setInterval(async () => {
  console.log("job stats", await aggregation_queue.getJobCounts());
  const jobs = await aggregation_queue.getJobs(["completed"]);

  if (jobs.length > 0) {
    const data = jobs.map((job) => job.data);

    console.log("Processing batch:", data);

    let res = 0;
    data.forEach(({ queueName, type }) => {
      const priority = getPriority(queueName);
      res += priority * (type === "INC" ? 1 : -1);
    });
    res = res > 0 ? 1 : -1;
    console.log("aggregation result", { res });

    if (res != 0) {
      try {
        const resp = await app.inject({
          method: "POST",
          url: `/api/hpa`,
          payload: { target: res },
        });
        console.log("hpa update result", resp.json());
      } catch (e) {
        console.log("failed to update HPA to ", res);
      }
    }

    for (const job of jobs) {
      await job.remove();
    }
  } else {
    console.log("No jobs to process 🤷");
  }
}, config.get("evaluation_period"));

export async function addJob(data) {
  const stringified = data.queueName + data.type;

  try {
    await aggregation_queue.add(`job:${stringified}`, data, {
      jobId: stringified,
    });
    console.log(`Job ${stringified} added ✅`);
  } catch (err) {
    console.error("Error adding job", err);
  }
}
