import express from "express";
import { Client, middleware } from "@line/bot-sdk";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "YOUR_CHANNEL_ACCESS_TOKEN",
  channelSecret: process.env.LINE_CHANNEL_SECRET || "YOUR_CHANNEL_SECRET"
};

const client = new Client(config);
const app = express();

app.post("/webhook", middleware(config), async (req, res) => {
  try {
    const result = await Promise.all(req.body.events.map(handleEvent));
    res.json(result);
  } catch {
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return null;
  const userMessage = event.message.text;
  const replyText = userMessage.includes("นัดหมาย")
    ? "อาริศาขอช่วยนัดหมอให้ค่ะ~ กรุณาพิมพ์ชื่อแผนก วันที่ และเวลานะคะ 😊"
    : `อาริศาได้รับข้อความของคุณแล้วค่ะ: "${userMessage}"`;
  await client.replyMessage(event.replyToken, { type: "text", text: replyText });
  return true;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
