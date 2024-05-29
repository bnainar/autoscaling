import fastify from "fastify";
import process from "node:process";
import k8s from "@kubernetes/client-node";
import axios from "axios";
import config from "config";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const metricsClient = new k8s.Metrics(kc);

const k8sCoreApiClient = kc.makeApiClient(k8s.CoreV1Api);

/**
 * @param {string} queueName
 * @returns {Promise<{pods: (k8s.V1PodStatus | undefined)[], globalConcurrency: number}>}
 */
async function fetchPods(queueName) {
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

  let globalConcurrency = 0;
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
      return y;
    })
  );
  return { pods, globalConcurrency };
}

const app = fastify({ logger: true });

app.get("/status", (_, res) => {
  res.send("Alive");
});

app.get("/ready", (_, res) => {
  res.code(200).send();
});

app.get("/api/hpa/:num", async (request, res) => {
  const num = Number(request.params.num);
  console.log("mamma mia");
  const namespace = config.get("K8S_NAMESPACE");
  const k8sAutoScalingClient = kc.makeApiClient(k8s.AutoscalingV2Api);

  try {
    const hpaList =
      await k8sAutoScalingClient.readNamespacedHorizontalPodAutoscaler(
        config.get("HPA-name"),
        namespace
      );
    const targetHPA = hpaList.body;
    const maxHPA = config.get("MAX_HPA");
    if (targetHPA.spec.maxReplicas >= maxHPA)
      return res
        .status(500)
        .send("reached max HPA " + targetHPA.spec.maxReplicas);

    targetHPA.spec.maxReplicas = num;
    try {
      const updatedHPA =
        await k8sAutoScalingClient.replaceNamespacedHorizontalPodAutoscaler(
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

app.get("/pods/:queueName", async (request, res) => {
  const { queueName } = request.params;

  try {
    const { globalConcurrency, pods } = await fetchPods(queueName);
    try {
      const topPodsRes1 = await k8s.topPods(
        k8sCoreApiClient,
        metricsClient,
        config.get("K8S_NAMESPACE")
      );
      const podsColumns = topPodsRes1.map((pod) => {
        return {
          POD: pod.Pod.metadata.name,
          "CPU(cores)": pod.CPU.CurrentUsage.toString(),
          "MEMORY(bytes)": pod.Memory.CurrentUsage.toString(),
        };
      });
      console.table(podsColumns);
      return res.send({ pods, podsColumns, globalConcurrency });
    } catch (e) {
      console.log("failed to connect to metrics server", e);
      return res.code(500).send("failed to connect to metrics server");
    }
  } catch (error) {
    console.error("Error fetching pods:", error);
    res.status(500).send("Failed to fetch pods");
  }
});

const queueLimits = config.get("QUEUE_LIMITS");

app.post("/concurrency/:queueName", async (request, res) => {
  const { queueName } = request.params;
  const { target } = request.body;

  if (!queueLimits[queueLimits])
    return res.code(404).send("Config not set for the desired queue");

  const { pods, globalConcurrency } = await fetchPods(queueName);

  const numPods = pods.length;

  if (numPods === 0) {
    return res.status(500).send("No pods available");
  }

  let newGlobalConcurrency;
  if (target == -1) {
    newGlobalConcurrency = globalConcurrency - queueLimits[queueName].decStep;
  } else if (target == 1) {
    newGlobalConcurrency = globalConcurrency + queueLimits[queueName].incStep;
  } else return res.code(400).send("invalid target");

  const basePodConcurrency = Math.floor(newGlobalConcurrency / numPods);
  let remainder = newGlobalConcurrency % numPods;
  console.log({ newGlobalConcurrency, basePodConcurrency, remainder });

  if (newGlobalConcurrency > queueLimits[queueName].globalMax)
    return res.code(500).send("Global max reached " + newGlobalConcurrency);

  if (basePodConcurrency >= queueLimits[queueName].podMax)
    return res.code(500).send("Pod max reached " + basePodConcurrency);

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

  res.send("ok");
});

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT ?? 3003);

await app.listen({ host: HOST, port: PORT });
