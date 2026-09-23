const admin = require("firebase-admin");
const crypto = require("crypto");

const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN || "https://shabaj9769-alt.github.io";

function initFirebase() {
  if (admin.apps.length) {
    return admin.app();
  }

  if (
    !process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    !process.env.FIREBASE_DATABASE_URL
  ) {
    throw new Error("Firebase environment variables are missing");
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    );
  } catch (error) {
    throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT_JSON");
  }

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");
}

function send(res, status, data) {
  return res.status(status).json(data);
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return send(res, 405, {
      verified: false,
      error: "Method not allowed",
    });
  }

  try {
    initFirebase();

    // -----------------------------
    // 1. Firebase login verification
    // -----------------------------
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return send(res, 401, {
        verified: false,
        error: "Missing Firebase authentication token",
      });
    }

    const idToken = authHeader.substring(7).trim();

    if (!idToken) {
      return send(res, 401, {
        verified: false,
        error: "Invalid Firebase authentication token",
      });
    }

    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    // -----------------------------
    // 2. Read payment information
    // -----------------------------
    const {
      orderId,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    } = req.body || {};

    if (
      !orderId ||
      !razorpayOrderId ||
      !razorpayPaymentId ||
      !razorpaySignature
    ) {
      return send(res, 400, {
        verified: false,
        error: "Missing payment verification data",
      });
    }

    // -----------------------------
    // 3. Load order from Firebase
    // -----------------------------
    const db = admin.database();
    const orderRef = db.ref(`orders/${orderId}`);
    const snapshot = await orderRef.once("value");

    if (!snapshot.exists()) {
      return send(res, 404, {
        verified: false,
        error: "Order not found",
      });
    }

    const order = snapshot.val();

    // -----------------------------
    // 4. Verify order ownership
    // -----------------------------
    if (!order.uid || order.uid !== uid) {
      return send(res, 403, {
        verified: false,
        error: "You are not authorized for this order",
      });
    }

    // -----------------------------
    // 5. Prevent duplicate/cancelled payment
    // -----------------------------
    if (
      order.deliveryStatus === "Order Successful" ||
      order.paymentStatus === "paid"
    ) {
      return send(res, 409, {
        verified: false,
        error: "Order payment is already verified",
      });
    }

    if (
      order.status === "Cancelled" ||
      order.deliveryStatus === "Cancelled"
    ) {
      return send(res, 409, {
        verified: false,
        error: "Cancelled order cannot be paid",
      });
    }

    // -----------------------------
    // 6. Verify Razorpay Order ID
    // -----------------------------
    if (
      !order.razorpayOrderId ||
      order.razorpayOrderId !== razorpayOrderId
    ) {
      return send(res, 400, {
        verified: false,
        error: "Razorpay order mismatch",
      });
    }

    // -----------------------------
    // 7. Verify Razorpay signature
    // -----------------------------
    if (!process.env.RZP_KEY_SECRET) {
      throw new Error("RZP_KEY_SECRET is missing");
    }

    const generatedSignature = crypto
      .createHmac("sha256", process.env.RZP_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    const receivedBuffer = Buffer.from(razorpaySignature, "utf8");
    const generatedBuffer = Buffer.from(generatedSignature, "utf8");

    if (
      receivedBuffer.length !== generatedBuffer.length ||
      !crypto.timingSafeEqual(receivedBuffer, generatedBuffer)
    ) {
      return send(res, 400, {
        verified: false,
        error: "Invalid Razorpay payment signature",
      });
    }

    // -----------------------------
    // 8. Payment verified
    // -----------------------------
    const updates = {
      deliveryStatus: "Order Successful",
      paymentStatus: "paid",
      razorpayPaymentId: razorpayPaymentId,
      paymentVerifiedAt: admin.database.ServerValue.TIMESTAMP,
    };

    await orderRef.update(updates);

    // -----------------------------
    // 9. Final response
    // -----------------------------
    return send(res, 200, {
      verified: true,
      message: "Payment verified successfully",
      orderId: orderId,
      razorpayPaymentId: razorpayPaymentId,
    });
  } catch (error) {
    console.error("VERIFY PAYMENT ERROR:", error);

    return send(res, 500, {
      verified: false,
      error: "Payment verification failed",
    });
  }
};
