import mongoose from "mongoose";

const ContactSchema = new mongoose.Schema({
  userId:{
    type: String,
    required: true,
  },
  waId: {
    type: String,
  },
  name: { type: String },
  pushname: String,
  isBusiness: Boolean,
  profilePicUrl: String,
  isRegistered: { type: Boolean, default: false },
  isBlocked: { type: Boolean, default: false },
  updatedAt: {
    type: Date,
    default: new Date(),
  },
});

ContactSchema.index({ userId: 1, waId: 1 }, { unique: true });

const contactModel = mongoose.model("contact", ContactSchema);
export default contactModel;
