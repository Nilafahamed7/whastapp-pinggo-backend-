import mongoose from "mongoose";

const ParticipantSchema = new mongoose.Schema(
  {
    waId: { type: String, required: true },
    name: { type: String },
    isAdmin: { type: Boolean, default: false },
    isSuperAdmin: { type: Boolean, default: false },
  },
  { _id: false }
);

const GroupSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true }, // ✅ track which WA session owns this group
    groupId: { type: String, unique: true, required: true },
    subject: String,
    description: String,
    participants: [ParticipantSchema],
    settings: {
      canSend: { type: String, default: "all" },
      canEditInfo: { type: String, default: "admins" },
    },
  },
  { timestamps: true } // ✅ createdAt & updatedAt automatically managed
);

const GroupModel = mongoose.model("Group", GroupSchema);
export default GroupModel;
