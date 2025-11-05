import mongoose from "mongoose";
import { restoreSessions } from "../services/waManager.js";

const ConnectedDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("💾 Database connected successfully");

    // Restore all active WhatsApp sessions after DB connects (non-blocking)
    restoreSessions().catch((err) => 
      console.error("❌ Session restoration error:", err.message)
    );
  } catch (e) {
    console.error("❌ Database connection error:", e.message);
    process.exit(1);
  }
};

export default ConnectedDB;
