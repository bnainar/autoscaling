import fastify from "fastify";
import process from "node:process";
import fs from "node:fs/promises";
import k8s from "@kubernetes/client-node";
import axios from "axios";
import config from "config";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const metricsClient = new k8s.Metrics(kc);

const k8sCoreApiClient = kc.makeApiClient(k8s.CoreV1Api);

// * @returns {Promise<{pods: (k8s.V1PodStatus | undefined)[], globalConcurrency: number}>}
async function fetchEligiblePods(queueName) {
  const podsRes = await k8sCoreApiClient.listNamespacedPod(
    config.get("K8S_NAMESPACE"),
    undefined,
    undefined,
    undefined,
    undefined,
    "app=" + config.get("TARGET_APP_LABEL")
  );

  if (!podsRes.body.items.length) {
    return res.status(404).send({ error: "No pods found" });
  }
  const resourcesAndMetrics = {};
  podsRes.body.items.forEach((pod) => {
    resourcesAndMetrics[pod.metadata.name] = {
      "spec.resources": pod.spec.containers[0].resources,
      currentMetrics: {},
      originalPodData: pod,
    };
  });
  try {
    const topPodsRes1 = await k8s.topPods(
      k8sCoreApiClient,
      metricsClient,
      config.get("K8S_NAMESPACE")
    );
    topPodsRes1.map((pod) => {
      if (resourcesAndMetrics[pod.Pod.metadata.name]) {
        resourcesAndMetrics[pod.Pod.metadata.name].currentMetrics = {
          "CPU(cores)": pod.CPU.CurrentUsage.toString(),
          "MEMORY(bytes)": pod.Memory.CurrentUsage.toString(),
        };
      }
    });
    // await fs.writeFile("out.json", JSON.stringify(resourcesAndMetrics));
    function parseMemory(memory) {
      const units = {
        Ki: 1024,
        Mi: 1024 ** 2,
        Gi: 1024 ** 3,
        Ti: 1024 ** 4,
        Pi: 1024 ** 5,
        Ei: 1024 ** 6,
      };
      const unit = memory.replace(/\d+/g, "").trim();
      const value = parseFloat(memory.replace(/[^\d.]/g, ""));
      return value * (units[unit] || 1);
    }

    function filterPods(pods, cpuThreshold, memoryThreshold) {
      const filteredPods = {};

      for (const pod in pods) {
        const cpuUsage = parseFloat(pods[pod].currentMetrics["CPU(cores)"]);
        const memoryUsage = parseFloat(
          pods[pod].currentMetrics["MEMORY(bytes)"]
        );
        const memoryLimit = parseMemory(
          pods[pod]["spec.resources"].limits.memory
        );

        const cpuPercentage =
          (cpuUsage / parseFloat(pods[pod]["spec.resources"].requests.cpu)) *
          1000 *
          100; // Convert cpu to cores and calculate percentage
        const memoryPercentage = (memoryUsage / memoryLimit) * 100;

        if (
          cpuPercentage < cpuThreshold &&
          memoryPercentage < memoryThreshold
        ) {
          filteredPods[pod] = pods[pod];
        }
      }

      return filteredPods;
    }

    const cpuThreshold = config.get("cpuThreshold"); // 15%
    const memoryThreshold = config.get("memoryThreshold");

    const filteredPods = filterPods(
      resourcesAndMetrics,
      cpuThreshold,
      memoryThreshold
    );

    let globalConcurrency = 0;
    const res = [];
    await Promise.all(
      Object.entries(filteredPods).map(async ([key, val]) => {
        const item = val.originalPodData;
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
            `http://${y.podIP}:${config.get(
              "targetPodPort"
            )}/api/bullmq/${queueName}/concurrency`
          );
          y.workerConcurrency = data;
          globalConcurrency += Number(data);
        } catch (e) {
          console.log(
            `Error connecting to pod ${item.metadata.name} at ${y.podIP}:`,
            e.message
          );
        }
        res.push(y);
      })
    );
    return { pods: res, globalConcurrency };
  } catch (e) {
    console.log("failed to connect to metrics server", e);
  }
}

const app = fastify({ logger: true });

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
    const maxHPA = config.get("MAX_HPA");
    if (targetHPA.spec.maxReplicas >= maxHPA)
      return res
        .status(500)
        .send("reached max HPA " + targetHPA.spec.maxReplicas);

    targetHPA.spec.maxReplicas += Number(target);
    try {
      const updatedHPA =
        await k8sAutoScalingClient.patchNamespacedHorizontalPodAutoscaler(
          targetHPA.metadata.name,
          namespace,
          targetHPA
        );
      console.log("Updated HPA");
      return res.send(updatedHPA.body);
    } catch (error) {
      console.error("Error updating HPA:", error);
      return res.status(500).send({ error: "Failed to update HPA" });
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
    res.status(500).send("Failed to fetch pods");
  }
});

const queueLimits = config.get("QUEUE_LIMITS");

app.post("/concurrency/:queueName", async (request, res) => {
  const { queueName } = request.params;
  const { target } = request.body;

  if (!queueLimits[queueName])
    return res.code(404).send({error: "Config not set for the desired queue"});

  const { pods, globalConcurrency } = await fetchEligiblePods(queueName);

  const numPods = pods.length;

  if (numPods === 0) {
    return res.status(500).send({error: "No pods available"});
  }

  let newGlobalConcurrency;
  if (target == -1) {
    newGlobalConcurrency = globalConcurrency - queueLimits[queueName].decStep;
  } else if (target == 1) {
    newGlobalConcurrency = globalConcurrency + queueLimits[queueName].incStep;
  } else return res.code(400).send({error: "invalid target"});

  const basePodConcurrency = Math.floor(newGlobalConcurrency / numPods);
  let remainder = newGlobalConcurrency % numPods;
  console.log({ newGlobalConcurrency, basePodConcurrency, remainder });

  let errorMsg;
  if (newGlobalConcurrency > queueLimits[queueName].globalMax)
    errorMsg = "Global max reached " + newGlobalConcurrency;

  if (basePodConcurrency >= queueLimits[queueName].podMax)
    errorMsg = "Pod max reached " + basePodConcurrency;

  if (errorMsg)
    return res.code(400).send({ errorMsg, action: "Try to increase the HPA" });

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

app.post('/webhook', async (request, reply) => {
  const payload = request.body;
  console.log("webhook recieved", payload.alerts)
  try {
    if (payload.status === 'firing') {
      const response = await app.inject({
        method: 'POST',
        url: `/concurrency/{${payload.alerts[0].labels.queue}}`,
        payload: {target: 1}
      });
      return reply.code(response.statusCode).send(response.json());
    } else if (payload.status === 'resolved') {
      console.log("why are you here when resolved");
      return reply.code(200);
    }  else {
      return reply.status(400).send({ success: false, message: 'Unknown webhook payload' });
    }
  } catch (error) {
    console.error(error);
    return reply.status(500).send({ success: false, message: 'Internal Server Error' });
  }
});

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT ?? 3003);

await app.listen({ host: HOST, port: PORT });
