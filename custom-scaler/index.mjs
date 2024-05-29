import fastify from "fastify";
import process from "node:process";
import fs from "node:fs/promises";
import k8s from "@kubernetes/client-node";
import axios from "axios";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const metricsClient = new k8s.Metrics(kc);

async function fetchPods(namespace, queueName) {
  const podsRes = await k8sApi.listNamespacedPod(
    namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    "app=" + process.env.TARGET_APP_LABEL
  );

  if (!podsRes.body.items.length) {
    return res.status(404).send({ error: "No pods found" });
  }

  let total = 0;
  const pods = await Promise.all(
    podsRes.body.items.map(async (item) => {
      const y = item.status;
      delete y["containerStatuses"];
      delete y["conditions"];

      y.name = item.metadata.name;

      if (!y.podIP) {
        console.log(`Pod ${item.metadata.name} has no IP assigned.`);
        return y;
      }

      try {
        console.log(`Connecting to pod ${item.metadata.name} at ${y.podIP}:`);
        const { data } = await axios.get(
          `http://${y.podIP}:3002/api/bullmq/${queueName}/concurrency`
        );
        y.workerConcurrency = data;
        total += Number(data);
      } catch (e) {
        console.log(
          `Error connecting to pod ${item.metadata.name} at ${y.podIP}:`,
          e.message
        );
      }
      return y;
    })
  );
  return { pods, total };
}
const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT ?? 3003);

const app = fastify({ logger: true });

app.get("/status", (_, res) => {
  res.send("Alive");
});

app.get("/ready", (_, res) => {
  res.code(200).send();
});

app.get("/api/hpa", async (_, res) => {
  console.log("mamma mia");
  const namespace = process.env.K8S_NAMESPACE;
  const k8sAutoScalingClient = kc.makeApiClient(k8s.AutoscalingV2Api);

  try {
    const hpaList =
      await k8sAutoScalingClient.listNamespacedHorizontalPodAutoscaler(
        namespace
      );
    const targetHPA = hpaList.body.items[0];
    const maxHPA = Number(process.env.MAX_HPA);
    if (targetHPA.spec.maxReplicas >= maxHPA)
      return res
        .status(500)
        .send("reached max HPA" + targetHPA.spec.maxReplicas);
    targetHPA.spec.maxReplicas += 1;
    try {
      const updatedHPA = await k8sApi.replaceNamespacedHorizontalPodAutoscaler(
        targetHPA.metadata.name,
        namespace,
        targetHPA
      );
      console.log("Updated HPA:", updatedHPA.body);
      res.send(updatedHPA.body); // Send the updated HPA as the response
    } catch (error) {
      console.error("Error updating HPA:", error);
      res.status(500).send({ error: "Failed to update HPA" });
    }

    res.send(hpaList.body);
  } catch (error) {
    console.error("Error fetching HPA:", error);
    res.status(500).send({ error: "Failed to fetch HPA" });
  }
});

app.get("/pods/:queueName", async (request, res) => {
  const { queueName } = request.params;

  try {
    const { total, pods } = await fetchPods(
      process.env.K8S_NAMESPACE,
      queueName
    );
    let podsColumns;
    try {
      const topPodsRes1 = await k8s.topPods(k8sApi, metricsClient, name);
      podsColumns = topPodsRes1.map((pod) => {
        return {
          POD: pod.Pod.metadata.name,
          "CPU(cores)": pod.CPU.CurrentUsage.toString(),
          "MEMORY(bytes)": pod.Memory.CurrentUsage.toString(),
        };
      });
      console.table(podsColumns);
    } catch (e) {
      console.log("failed to connect to metrics server", e);
    }
    res.send({ pods, podsColumns, total });
  } catch (error) {
    console.error("Error fetching pods:", error);
    res.status(500).send({ error: "Failed to fetch pods" });
  }
});

const queueLimits = JSON.parse(process.env.QUEUE_LIMITS);

app.post("/concurrency/:queueName", async (request, res) => {
  const { queueName } = request.params;
  const { target } = request.body;
  
  
  const { pods, total } = await fetchPods(process.env.K8S_NAMESPACE, queueName);

  const numPods = pods.length;

  if (numPods === 0) {
    return res.status(500).send("No pods available");
  }
  let newConc;
  if(target == -1) {
    newConc = total - queueLimits[queueName].decStep;
  }
  else {
    newConc = total + queueLimits[queueName].incStep;
  }

  const baseConc = Math.floor(newConc / numPods);
  let remainder = newConc % numPods;
  console.log({newConc, baseConc, remainder})
  if (newConc > queueLimits[queueName].globalMax)
    return res.code(500).send("Global max reached");

  if (baseConc >= queueLimits[queueName].podMax)
    return res.code(500).send("Pod max reached");

  const adjustConcurrency = async (pod, adjustment) => {
    try {
      const { data } = await axios.post(
        `http://${pod.podIP}:3002/api/bullmq/${queueName}/concurrency`,
        { target: adjustment }
      );
      console.log(`adjusted ${pod.name} concurrency by ${adjustment}`, data);
      return true;
    } catch (e) {
      console.log(
        `failed to adjust ${pod.name} concurrency by ${adjustment}`,
        e.message
      );
      return false;
    }
  };

  const promises = pods.map(async (pod) => {
    let concurrency = baseConc;
    if (remainder > 0) {
      concurrency++;
      remainder--;
    }
    const oldConc = pod.workerConcurrency;
    let adjustment = concurrency - oldConc;

    while (adjustment !== 0) {
      const step = adjustment > 0 ? 1 : -1;
      const success = await adjustConcurrency(pod, step);
      if (!success) {
        break;
      }
      adjustment -= step;
    }
  });

  await Promise.all(promises);

  res.send("ok");
});

await app.listen({ host: HOST, port: PORT });
