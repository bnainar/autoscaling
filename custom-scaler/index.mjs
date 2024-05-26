import fastify from "fastify";
import process from "node:process";
import fs from "node:fs/promises";
import k8s from "@kubernetes/client-node";
import axios from "axios";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const metricsClient = new k8s.Metrics(kc);

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT ?? 3003);

const app = fastify({ logger: true });

app.get("/status", (_, res) => {
  res.send("Alive");
});

app.get("/ready", (_, res) => {
  res.code(200).send();
});

app.get("/pods/:name", async (request, res) => {
  const { name } = request.params;

  try {
    const podsRes = await k8sApi.listNamespacedPod(
      name,
      undefined,
      undefined,
      undefined,
      undefined,
      "app=sample-app"
    );

    if (!podsRes.body.items.length) {
      return res.status(404).send({ error: "No pods found" });
    }

    let total = 0;
    const x = await Promise.all(podsRes.body.items.map(async (item) => {
      const y = item.status;
      delete y["containerStatuses"];
      delete y["conditions"];
      console.log({ y });

      if (!y.podIP) {
        console.log(`Pod ${item.metadata.name} has no IP assigned.`);
        return y;
      }

      try {
        console.log(`Connecting to pod ${item.metadata.name} at ${y.podIP}:`);

        const { data } = await axios.get(`http://${y.podIP}:3002/api/bullmq/{SubmissionSync}/concurrency`);
        total += Number(data);
      } catch (e) {
        console.log(`Error connecting to pod ${item.metadata.name} at ${y.podIP}:`, e.message);
      }
      return y;
    }));

    console.log({ total });

    const topPodsRes1 = await k8s.topPods(k8sApi, metricsClient, name);
    const podsColumns = topPodsRes1.map((pod) => {
      return {
        POD: pod.Pod.metadata.name,
        "CPU(cores)": pod.CPU.CurrentUsage.toString(),
        "MEMORY(bytes)": pod.Memory.CurrentUsage.toString(),
      };
    });

    console.log("Top pods");
    console.table(podsColumns);

    res.send({ x, podsColumns });
  } catch (error) {
    console.error("Error fetching pods:", error);
    res.status(500).send({ error: "Failed to fetch pods" });
  }
});

await app.listen({ host: HOST, port: PORT });
