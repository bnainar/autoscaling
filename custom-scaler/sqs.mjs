import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { app } from "./fastify.mjs";
import config from "config";

const sqsClient = new SQSClient({
  region: "us-east-1",
  credentials: config.get("sqs"),
});

const queueUrl = config.get("sqs.queueName");

export async function pushMessage(messageBody) {
  const params = {
    QueueUrl: queueUrl,
    MessageBody: messageBody,
  };
  try {
    const data = await sqsClient.send(new SendMessageCommand(params));
    console.log("Message sent successfully:", data.MessageId);
  } catch (error) {
    console.error("Error sending message:", error);
  }
}
const highPriorityQueues = new Set(config.get("highPriorityQueues"));

function aggregateRequests(set) {
  let highPriorityInc = 0;
  let highPriorityDec = 0;
  let lowPriorityInc = 0;
  let lowPriorityDec = 0;

  const HIGH_PRIORITY_WEIGHT = 3;

  set.forEach((item) => {
    const [queueName, request] = item.split(",");

    if (highPriorityQueues.has(queueName)) {
      if (request === "INC") {
        highPriorityInc++;
      } else if (request === "DEC") {
        highPriorityDec++;
      }
    } else {
      if (request === "INC") {
        lowPriorityInc++;
      } else if (request === "DEC") {
        lowPriorityDec++;
      }
    }
  });

  const totalInc = highPriorityInc * HIGH_PRIORITY_WEIGHT + lowPriorityInc;
  const totalDec = highPriorityDec * HIGH_PRIORITY_WEIGHT + lowPriorityDec;

  if (totalInc > totalDec) {
    return "INC";
  } else if (totalDec > totalInc) {
    return "DEC";
  } else {
    return "NONE"; 
  }
}

let requestsArray = [];
async function pollQueue() {
  try {
    const { Messages } = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20, // Long polling for 20 seconds
      })
    );
    if (Messages) {
      for (const message of Messages) {
        console.log("Message received:", message.Body);
        requestsArray.push(message.Body);
        await sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          })
        );
        console.log("Message deleted:", message.MessageId);
      }
    } else {
      console.log("No messages received");
    }
  } catch (error) {
    console.error("Error receiving messages:", error);
  }
}

const pollPeriod = 20000; // 20 seconds

setInterval(pollQueue, pollPeriod);
setInterval(async () => {
  const len = requestsArray.length;
  const mySet = new Set(requestsArray);
  requestsArray = requestsArray.slice(len);
  const res = aggregateRequests(mySet);
  console.log("mySet", mySet, "aggregation result", res);
  if (res != "NONE") {
    try {
      const resp = await app.inject({
        method: "POST",
        url: `/api/hpa`,
        payload: { target: res === "INC" ? 1 : -1 },
      });
      console.log("hpa update result", resp.json());
    } catch (e) {
      console.log("failed to update HPA to ", res);
    }
  }
}, 40000);
