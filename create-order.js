const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase, ServerValue } = require("firebase-admin/database");
const Razorpay = require("razorpay");

function setCors(res) {
  const allowedOrigin =
    process.env.ALLOWED_ORIGIN || "https://shabaj9769-alt.github.io";

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
}

function initFirebase() {
  const existingApps = getApps();

  if (existingApps.length > 0) {
    return existingApps[0];
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw || !raw.trim()) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is missing in Vercel Environment Variables."
    );
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON."
    );
  }

  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is missing client_email or private_key."
    );
  }

  return initializeApp({
    credential: cert(serviceAccount),
    databaseURL:
      process.env.FIREBASE_DATABASE_URL ||
      "https://manorbiryani-default-rtdb.firebaseio.com",
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
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const app = initFirebase();

    const idToken = getBearerToken(req);

    if (!idToken) {
      return res.status(401).json({
        error: "Missing Firebase authentication token.",
      });
    }

    const auth = getAuth(app);

    const decodedToken = await auth.verifyIdToken(idToken);

    const uid = decodedToken.uid;

    let body = req.body || {};

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (error) {
        return res.status(400).json({
          error: "Invalid JSON body.",
        });
      }
    }

    const orderId = body.orderId
      ? String(body.orderId).trim()
      : "";

    if (!orderId) {
      return res.status(400).json({
        error: "orderId is required.",
      });
    }

    const db = getDatabase(app);

    const orderRef = db.ref(`orders/${orderId}`);

    const snapshot = await orderRef.once("value");

    if (!snapshot.exists()) {
      return res.status(404).json({
        error: "Order not found.",
      });
    }

    const order = snapshot.val();

    if (!order.uid || String(order.uid) !== String(uid)) {
      return res.status(403).json({
        error: "You are not allowed to pay for this order.",
      });
    }

    const deliveryStatus = String(
      order.deliveryStatus || ""
    ).toLowerCase();

    if (
      deliveryStatus === "order successful" ||
      deliveryStatus === "delivered" ||
      deliveryStatus === "cancelled"
    ) {
      return res.status(409).json({
        error: "This order is no longer payable.",
      });
    }

    const paymentMethod = String(
      order.payment || ""
    ).toLowerCase();

    if (
      paymentMethod !== "online" &&
      paymentMethod !== "razorpay"
    ) {
      return res.status(400).json({
        error: "This order is not an online payment order.",
      });
    }

    const total = Number(order.total);

    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({
        error: "Invalid order total.",
      });
    }

    const amountPaise = Math.round(total * 100);

    if (
      order.razorpayOrderId &&
      String(order.paymentStatus || "").toLowerCase() === "pending"
    ) {
      return res.status(200).json({
        success: true,
        razorpayOrderId: order.razorpayOrderId,
        amount: amountPaise,
        currency: "INR",
        reused: true,
      });
    }

    const keyId = process.env.RZP_KEY_ID;
    const keySecret = process.env.RZP_KEY_SECRET;

    if (!keyId || !keySecret) {
      return res.status(500).json({
        error: "Razorpay credentials are not configured.",
      });
    }

    const razorpay = new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    });

    const razorpayOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: String(orderId).slice(-40),
      notes: {
        firebaseOrderId: orderId,
        firebaseUid: uid,
      },
    });

    await orderRef.update({
      razorpayOrderId: razorpayOrder.id,
      paymentAmountPaise: amountPaise,
      paymentCurrency: "INR",
      paymentStatus: "pending",
      paymentCreatedAt: ServerValue.TIMESTAMP,
      deliveryStatus: "Awaiting Payment",
    });

    return res.status(200).json({
      success: true,
      razorpayOrderId: razorpayOrder.id,
      amount: amountPaise,
      currency: "INR",
    });

  } catch (error) {
    console.error("create-order server error:", error);

    return res.status(500).json({
      error:
        error && error.message
          ? error.message
          : "Unable to create secure payment order.",
    });
  }
};
