import process from "node:process";
// import fs from "node:fs/promises";
import k8s from "@kubernetes/client-node";
import axios from "axios";
import config from "config";
import { fetchEligiblePods } from "./fetchEligiblePods.mjs";
import { addJob } from "./aggregation_queue.mjs";
import { app } from "./fastify.mjs";

console.log(config.get("redis.nodes"));

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
export const metricsClient = new k8s.Metrics(kc);

export const k8sCoreApiClient = kc.makeApiClient(k8s.CoreV1Api);

app.get("/status", (_, res) => {
  res.send("Alive");
});

app.get("/ready", (_, res) => {
  res.code(200).send();
});

app.post("/api/hpa", async (request, res) => {
  const { target } = request.body;
  console.log("mamma mia");
  const namespace = config.get("K8S_NAMESPACE");
  const k8sAutoScalingClient = kc.makeApiClient(k8s.AutoscalingV2Api);

  try {
    const hpaRes =
      await k8sAutoScalingClient.readNamespacedHorizontalPodAutoscaler(
        config.get("HPA-name"),
        namespace
      );
    const targetHPA = hpaRes.body;
    const maxHPA = Number(config.get("MAX_HPA"));
    console.log({ maxHPA });
    if (target == 1 && targetHPA.spec.maxReplicas >= maxHPA) {
      console.log("reached max HPA " + targetHPA.spec.maxReplicas);
      return res
        .status(400)
        .send({ error: "reached max HPA " + targetHPA.spec.maxReplicas });
    }
    if (target == -1 && targetHPA.spec.maxReplicas <= 1) {
      console.log("reached min HPA " + targetHPA.spec.maxReplicas);
      return res
        .status(400)
        .send({ error: "reached min HPA " + targetHPA.spec.maxReplicas });
    }

    targetHPA.spec.maxReplicas += Number(target);
    try {
      const updatedHPA =
        await k8sAutoScalingClient.replaceNamespacedHorizontalPodAutoscaler(
          targetHPA.metadata.name,
          namespace,
          targetHPA
        );
      console.log("Updated HPA to", updatedHPA.body.spec.maxReplicas);
      return res.send({ maxReplicas: updatedHPA.body.spec.maxReplicas });
    } catch (error) {
      console.error("Error updating HPA:", error);
      return res
        .status(500)
        .send({ error: "Failed to update HPA", msg: error });
    }
  } catch (error) {
    console.error("Error fetching HPA:", error);
    res.status(500).send({ error: "Failed to fetch HPA" });
  }
});

app.get("/concurrency/:queueName", async (request, res) => {
  const { queueName } = request.params;

  try {
    const x = await fetchEligiblePods(queueName);
    return res.send(x);
  } catch (error) {
    console.error("Error fetching pods:", error);
    res.status(500).send({ error: "Failed to fetch pods" });
  }
});

const queueLimits = config.get("QUEUE_LIMITS");

app.post("/concurrency/:queueName", async (request, res) => {
  const { queueName } = request.params;
  const { target } = request.body;

  if (!queueLimits[queueName]) {
    console.log(`Config not set for the ${queueName}`);
    return res.code(404).send({ error: `Config not set for the ${queueName}` });
  }

  const { pods, globalConcurrency } = await fetchEligiblePods(queueName);

  const numPods = pods.length;

  if (numPods === 0) {
    console.log("no pods available");
    return res.status(500).send({ error: "No pods available" });
  }

  let newGlobalConcurrency;
  if (target == -1) {
    newGlobalConcurrency = globalConcurrency - queueLimits[queueName].decStep;
  } else if (target == 1) {
    newGlobalConcurrency = globalConcurrency + queueLimits[queueName].incStep;
  } else {
    console.log("invalid concurrency target");
    return res.code(400).send({ error: "invalid target" });
  }

  const basePodConcurrency = Math.floor(newGlobalConcurrency / numPods);
  let remainder = newGlobalConcurrency % numPods;
  console.log({ newGlobalConcurrency, basePodConcurrency, remainder });

  let errorMsg;
  // if (target == 1 && newGlobalConcurrency > queueLimits[queueName].globalMax) {
  //   errorMsg = "Global max reached " + newGlobalConcurrency;
  // }

  if (target == 1 && basePodConcurrency >= queueLimits[queueName].podMax) {
    errorMsg = { error: "Pod max reached " + basePodConcurrency, type: "INC" };
  }

  if (target == -1 && basePodConcurrency <= queueLimits[queueName].podMin) {
    errorMsg = { error: "Pod min reached " + basePodConcurrency, type: "DEC" };
  }
  if (errorMsg?.type) {
    addJob({ queueName, type: errorMsg.type });
    return res.code(400).send();
  }

  /**
   * @param {k8s.V1PodStatus | undefined} pod
   * @param {1 | -1} adjustment
   * @returns {Promise<boolean>}
   */
  const adjustConcurrency = async (pod, adjustment) => {
    try {
      const { data } = await axios.post(
        `http://${pod.podIP}:${config.get(
          "targetPodPort"
        )}/api/bullmq/${queueName}/concurrency`,
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
    let newPodConcurrency = basePodConcurrency;
    if (remainder > 0) {
      newPodConcurrency++;
      remainder--;
    }
    const previousPodConcurrency = pod.workerConcurrency;
    let adjustment = newPodConcurrency - previousPodConcurrency;

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

  res.send({ newGlobalConcurrency, basePodConcurrency });
});

app.post("/webhook", async (request, reply) => {
  const payload = request.body;
  console.log("webhook recieved", payload.alerts);
  try {
    if (payload.status === "firing") {
      let abs = 0;
      payload.alerts.forEach((alert) => {
        abs += alert.labels.alertname === "HighWaitingJobs" ? 1 : -1;
      });
      if (abs == 0) console.log("what");
      const promises = payload.alerts.map(async (alert) => {
        await app.inject({
          method: "POST",
          url: `/concurrency/{${alert.labels.queue}}`,
          payload: { target: abs > 0 ? 1 : -1 },
        });
      });
      await Promise.all(promises);
      return reply.code(200);
    } else if (payload.status === "resolved") {
      console.log("why are you here when resolved");
      return reply.code(200);
    } else {
      return reply
        .status(400)
        .send({ success: false, message: "Unknown webhook payload" });
    }
  } catch (error) {
    console.error(error);
    return reply
      .status(500)
      .send({ success: false, message: "Internal Server Error" });
  }
});

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT ?? 3003);

await app.listen({ host: HOST, port: PORT });
