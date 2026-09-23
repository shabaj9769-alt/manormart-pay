const admin = require("firebase-admin");
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
  if (admin.apps.length > 0) {
    return admin.app();
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

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
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
    // -----------------------------------------
    // Firebase Admin initialization
    // -----------------------------------------
    const firebaseApp = initFirebase();

    // -----------------------------------------
    // Verify Firebase ID Token
    // -----------------------------------------
    const idToken = getBearerToken(req);

    if (!idToken) {
      return res.status(401).json({
        error: "Missing Firebase authentication token.",
      });
    }

    const decodedToken = await firebaseApp
      .auth()
      .verifyIdToken(idToken);

    const uid = decodedToken.uid;

    // -----------------------------------------
    // Read request body
    // -----------------------------------------
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

    // -----------------------------------------
    // Read order from Firebase
    // -----------------------------------------
    const db = firebaseApp.database();
    const orderRef = db.ref(`orders/${orderId}`);
    const snapshot = await orderRef.once("value");

    if (!snapshot.exists()) {
      return res.status(404).json({
        error: "Order not found.",
      });
    }

    const order = snapshot.val();

    // -----------------------------------------
    // Verify order ownership
    // -----------------------------------------
    if (!order.uid || String(order.uid) !== String(uid)) {
      return res.status(403).json({
        error: "You are not allowed to pay for this order.",
      });
    }

    // -----------------------------------------
    // Do not create Razorpay order for
    // completed/cancelled orders
    // -----------------------------------------
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

    // -----------------------------------------
    // Make sure this is an online payment
    // -----------------------------------------
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

    // -----------------------------------------
    // IMPORTANT:
    // Amount comes ONLY from Firebase order.
    // Never trust amount sent by the app.
    // -----------------------------------------
    const total = Number(order.total);

    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({
        error: "Invalid order total.",
      });
    }

    const amountPaise = Math.round(total * 100);

    // -----------------------------------------
    // If Razorpay order already exists,
    // reuse it instead of creating duplicate
    // payment orders.
    // -----------------------------------------
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

    // -----------------------------------------
    // Razorpay credentials
    // -----------------------------------------
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

    // -----------------------------------------
    // Create Razorpay order
    // -----------------------------------------
    const razorpayOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: String(orderId).slice(-40),
      notes: {
        firebaseOrderId: orderId,
        firebaseUid: uid,
      },
    });

    // -----------------------------------------
    // Save payment information in Firebase
    // -----------------------------------------
    await orderRef.update({
      razorpayOrderId: razorpayOrder.id,
      paymentAmountPaise: amountPaise,
      paymentCurrency: "INR",
      paymentStatus: "pending",
      paymentCreatedAt: admin.database.ServerValue.TIMESTAMP,
      deliveryStatus: "Awaiting Payment",
    });

    // -----------------------------------------
    // Send safe response to app
    // -----------------------------------------
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
