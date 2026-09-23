const admin = require("firebase-admin");

function initFirebase() {
  if (admin.apps.length) return admin.app();

  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  );

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  return header.slice(7).trim();
}

module.exports = async (req, res) => {
  const allowedOrigin =
    process.env.ALLOWED_ORIGIN || "https://shabaj9769-alt.github.io";

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    // Required environment variables
    const {
      RZP_KEY_ID,
      RZP_KEY_SECRET,
      FIREBASE_DATABASE_URL,
      FIREBASE_SERVICE_ACCOUNT_JSON,
    } = process.env;

    if (
      !RZP_KEY_ID ||
      !RZP_KEY_SECRET ||
      !FIREBASE_DATABASE_URL ||
      !FIREBASE_SERVICE_ACCOUNT_JSON
    ) {
      return res.status(500).json({
        error: "Server payment configuration is incomplete",
      });
    }

    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({
        error: "Authentication required",
      });
    }

    const firebase = initFirebase();

    // Verify Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(token);
    const uid = decodedToken.uid;

    let body = req.body || {};

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({
          error: "Invalid JSON body",
        });
      }
    }

    const orderId = String(body.orderId || "").trim();
    const receipt = String(body.receipt || "").trim();

    if (!orderId) {
      return res.status(400).json({
        error: "orderId is required",
      });
    }

    // IMPORTANT:
    // Client is NOT allowed to send amount.
    // Amount is read from the existing Firebase order.
    const db = firebase.database();
    const orderRef = db.ref(`orders/${orderId}`);
    const snapshot = await orderRef.once("value");

    if (!snapshot.exists()) {
      return res.status(404).json({
        error: "Order not found",
      });
    }

    const order = snapshot.val();

    // Order must belong to logged-in Firebase user
    if (!order.uid || order.uid !== uid) {
      return res.status(403).json({
        error: "You are not allowed to pay for this order",
      });
    }

    // Only online-payment orders can reach Razorpay
    const paymentMode = String(
      order.paymentMode || order.paymentMethod || ""
    ).toLowerCase();

    if (
      paymentMode &&
      !["online", "razorpay", "prepaid"].includes(paymentMode)
    ) {
      return res.status(400).json({
        error: "This order is not an online payment order",
      });
    }

    // Payment must still be pending
    const currentStatus = String(
      order.deliveryStatus || order.status || ""
    );

    if (
      currentStatus === "Order Successful" ||
      currentStatus === "Delivered" ||
      currentStatus === "Cancelled"
    ) {
      return res.status(409).json({
        error: "This order cannot be paid again",
        status: currentStatus,
      });
    }

    // Server-side total
    const total = Number(order.total);

    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({
        error: "Invalid server-side order total",
      });
    }

    // Never accept amount from browser.
    const amountPaise = Math.round(total * 100);

    if (
      !Number.isSafeInteger(amountPaise) ||
      amountPaise < 100
    ) {
      return res.status(400).json({
        error: "Invalid payment amount",
      });
    }

    const auth = Buffer.from(
      `${RZP_KEY_ID}:${RZP_KEY_SECRET}`
    ).toString("base64");

    const razorpayResponse = await fetch(
      "https://api.razorpay.com/v1/orders",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: amountPaise,
          currency: "INR",
          receipt:
            receipt ||
            `manor_${orderId}`.slice(0, 40),
          notes: {
            firebaseOrderId: orderId,
            firebaseUid: uid,
          },
        }),
      }
    );

    const data = await razorpayResponse.json();

    if (!razorpayResponse.ok) {
      console.error("Razorpay create-order error:", data);

      return res.status(502).json({
        error: "Unable to create Razorpay order",
      });
    }

    // Save Razorpay order ID against the Firebase order.
    // This will later be required during signature verification.
    await orderRef.update({
      razorpayOrderId: data.id,
      paymentAmountPaise: amountPaise,
      paymentCurrency: "INR",
      paymentCreatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    return res.status(200).json({
      id: data.id,
      entity: data.entity,
      amount: data.amount,
      currency: data.currency,
      receipt: data.receipt,
    });
  } catch (error) {
    console.error("create-order server error:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
};
