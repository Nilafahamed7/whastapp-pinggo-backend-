import mongoose from 'mongoose';

const SessionSchema = new mongoose.Schema({
    userId: { type: String, ref: "User", required: true },
    sessionName: { type: String, default: '' },
    sessionId: {
        type: String,
        unique: true,
    },
    status: {
        type: String,
        default: 'pending'
    },
    phoneNumber: { type: String },
    qr: {
        type: String,
    },
    authData: {
        type: mongoose.Schema.Types.Mixed
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
})

const sessionModel = mongoose.model('session',SessionSchema)

export default sessionModel;