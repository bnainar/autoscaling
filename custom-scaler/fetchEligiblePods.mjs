import k8s from "@kubernetes/client-node";
import axios from "axios";
import config from "config";
import { k8sCoreApiClient, metricsClient } from "./index.mjs";

// * @returns {Promise<{pods: (k8s.V1PodStatus | undefined)[], globalConcurrency: number}>}
export async function fetchEligiblePods(queueName) {
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

        const cpuPercentage = (cpuUsage / parseFloat(pods[pod]["spec.resources"].requests.cpu)) *
          1000 *
          100; // Convert cpu to cores and calculate percentage
        const memoryPercentage = (memoryUsage / memoryLimit) * 100;

        if (cpuPercentage < cpuThreshold &&
          memoryPercentage < memoryThreshold) {
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
            )}/api/workers/${queueName}/concurrency`
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
