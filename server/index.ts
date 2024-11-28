import fs from "fs";
import cors from "cors";
import http from "http";
import axios from "axios";
import express from "express";
import { Readable } from "stream";
import { Server } from "socket.io";
import { s3Client } from "./lib/s3";
import { openai } from "./lib/openai";
import logger from "./middleware/logger";
import { PutObjectCommand } from "@aws-sdk/client-s3";

export const app = express();

const server = http.createServer(app);

const port = process.env.PORT || 3001;

//Logger middleware
app.use(logger);

//Middleware
app.use(cors());
app.disable("x-powered-by");

const io = new Server(server, {
  cors: {
    origin: process.env.ELECTRON_HOST,
    methods: ["GET", "POST"],
  },
});

let recordedChunks: any = [];

io.on("connection", (socket) => {
  console.log(`Socket is connected`);

  socket.on("video-chunks", async (data) => {
    console.log("Video chunk is sent");

    const writeStream = fs.createWriteStream(`temp-upload/${data.fileName}`);

    recordedChunks.push(data.chunks);

    const videoBlob = new Blob(recordedChunks, {
      type: "video/webm; codecs=vp9",
    });

    const buffer = Buffer.from(await videoBlob.arrayBuffer());

    const readStream = Readable.from(buffer);

    readStream.pipe(writeStream).on("finish", () => {
      console.log("Chunk Saved!");
    });
  });

  socket.on("process-video", async (data) => {
    console.log("Processing video...");

    recordedChunks = [];

    fs.readFile(`temp-upload/${data.fileName}`, async (err, file) => {
      const processing = await axios.post(
        `${process.env.NEXT_API_HOST}/recordings/${data.userId}/processing`
      );

      if (processing.data.status !== 200) {
        console.log(
          `Something went wrong with processing file, ${processing.data.error}`
        );

        return;
      }

      // AWS: sending to S3 Bucket
      const putObjectCommand = new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME || "",
        Key: data.fileName,
        ContentType: "video/webm",
        Body: file,
        Metadata: {
          userId: data.userId,
        },
      });

      const fileStatus = await s3Client.send(putObjectCommand);

      if (fileStatus["$metadata"].httpStatusCode !== 200) {
        console.log("Error sending file to AWS!");

        return;
      }

      console.log("Video uploaded to AWS!");

      // Getting video summary with Open AI (Whisper).
      if (processing.data.result.subscription.plan === "PRO") {
        fs.stat(`temp-upload/${data.fileName}`, async (err, stat) => {
          if (err) {
            console.log("Error in stat for file!", err);

            return;
          }

          if (stat.size > 25000000) {
            console.log("File too large for Whisper and Open AI");

            return;
          }

          // Generate transcript with openAI (Whisper).
          const transcription = await openai.audio.transcriptions.create({
            model: "whisper-1",
            file: fs.createReadStream(`temp-upload/${data.fileName}`),
            response_format: "text",
          });

          if (!transcription) {
            console.log("Open AI unable to transcribe file!");

            return;
          }

          // Generate title and description with openAI.
          const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            response_format: {
              type: "json_object",
            },
            messages: [
              {
                role: "system",
                content: `You are a helpful assistant. You are going to generate a really nice title and description using the speech to text transcription: ${transcription}. You have to return it in this json format: {"title": <title>, "summary":<description>}. Note: don't make it so long.`,
              },
            ],
          });

          // Save video title and summary in the database
          const titleAndSummaryGenerated = await axios.post(
            `${process.env.NEXT_API_HOST}/recordings/${data.userId}/transcribe`,
            {
              fileName: data.fileName,
              transcript: transcription,
              content: completion.choices[0].message.content,
            }
          );

          if (titleAndSummaryGenerated.data.status !== 200) {
            console.log(
              `Error: Something went wrong saving to the database, ${titleAndSummaryGenerated.data.error}`
            );
          }
        });
      }

      // Stop all processes.
      const stopProcessing = await axios.post(
        `${process.env.NEXT_API_HOST}/recordings/${data.userId}/complete`,
        {
          fileName: data.fileName,
        }
      );

      if (stopProcessing.data.status !== 200) {
        console.log(
          `Error: Something went wrong stopping process in the web API, ${stopProcessing.data.error}`
        );
      }

      // Delete temp file.
      fs.unlink(`temp-upload/${data.fileName}`, (err) => {
        if (!err) {
          console.log(`${data.fileName} was deleted successfully!`);
        }
      });
    });
  });

  socket.on("disconnect", async () => {
    console.log("Socket disconnected!");
  });
});

server.listen(port, () => {
  console.log(`App running on port:${port}`);
});
