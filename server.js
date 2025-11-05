import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db.js";

import sessionRoute from "./routes/session.route.js";
import contactRoute from "./routes/contact.route.js";
import groupRoute from "./routes/group.route.js";
import messageRoute from "./routes/message.route.js";
import mediaRoute from "./routes/media.route.js";
import utilityRoute from "./routes/utility.route.js";
import webhookRoute from "./routes/webhook.route.js";

dotenv.config();

const app = express();

// CORS Configuration - Allow all origins for development and production
app.use(cors({
  origin: '*', // Allow all origins
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  exposedHeaders: ['Content-Range', 'X-Content-Range']
}));

// Handle preflight requests
app.options('*', cors());

app.use(express.json());

// API key middleware (skip for health check)
app.use((req, res, next) => {
  if (req.path === "/api/wa/session/health") return next();

  const apiKey = req.header("x-api-key");
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
});

// Routes
app.use("/api/wa/session", sessionRoute);
app.use("/api/wa/contact", contactRoute);
app.use("/api/wa/group", groupRoute);
app.use("/api/wa/message", messageRoute);
app.use("/api/wa/media", mediaRoute);
app.use("/api/wa/utility", utilityRoute);
app.use("/api/wa/webhook", webhookRoute);

// Health check route
app.get("/api/wa/session/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 WhatsApp API Server Started`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`⏰ Time: ${new Date().toLocaleString()}`);
  console.log(`${'='.repeat(50)}\n`);
});

// Connect Database (sessions will be restored in db.js)
connectDB().catch((err) => {
  console.error("❌ Database connection failed:", err.message);
  process.exit(1);
});
