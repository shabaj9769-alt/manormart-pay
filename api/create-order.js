const {
  initializeApp,
  getApps,
  cert,
} = require("firebase-admin/app");

const {
  getAuth,
} = require("firebase-admin/auth");

const {
  getDatabase,
} = require("firebase-admin/database");

function setCors(res) {
  const allowedOrigin =
    process.env.ALLOWED_ORIGIN ||
    "https://shabaj9769-alt.github.io";

  res.setHeader(
    "Access-Control-Allow-Origin",
    allowedOrigin
  );

  res.setHeader("Vary", "Origin");

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
}

function initFirebase() {
  const apps = getApps();

  if (apps.length > 0) {
    return apps[0];
  }

  const raw =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw || !raw.trim()) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is missing."
    );
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is invalid JSON."
    );
  }

  if (
    !serviceAccount.client_email ||
    !serviceAccount.private_key
  ) {
    throw new Error(
      "Firebase service account is missing client_email or private_key."
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
  const header =
    req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  return header.slice(7).trim();
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    // -----------------------------
    // Firebase initialization
    // -----------------------------

    const firebaseApp = initFirebase();

    const auth = getAuth(firebaseApp);
    const db = getDatabase(firebaseApp);

    // -----------------------------
    // Firebase authentication
    // -----------------------------

    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({
        error: "Authentication required",
      });
    }

    const decodedToken =
      await auth.verifyIdToken(token);

    const uid = decodedToken.uid;

    // -----------------------------
    // Request body
    // -----------------------------

    let body = req.body || {};

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (error) {
        return res.status(400).json({
          error: "Invalid JSON body",
        });
      }
    }

    const orderId =
      String(body.orderId || "").trim();

    if (!orderId) {
      return res.status(400).json({
        error: "orderId is required",
      });
    }

    // -----------------------------
    // Read Firebase order
    // -----------------------------

    const orderRef =
      db.ref(`orders/${orderId}`);

    const snapshot =
      await orderRef.once("value");

    if (!snapshot.exists()) {
      return res.status(404).json({
        error: "Order not found",
      });
    }

    const order = snapshot.val();

    // -----------------------------
    // Ownership check
    // -----------------------------

    if (
      !order.uid ||
      String(order.uid) !== String(uid)
    ) {
      return res.status(403).json({
        error:
          "You are not allowed to pay for this order",
      });
    }

    // -----------------------------
    // Payment method check
    // -----------------------------

    const paymentMethod = String(
      order.payment ||
      order.paymentMode ||
      order.paymentMethod ||
      ""
    ).toLowerCase();

    if (
      paymentMethod !== "online" &&
      paymentMethod !== "razorpay" &&
      paymentMethod !== "prepaid"
    ) {
      return res.status(400).json({
        error:
          "This order is not an online payment order",
      });
    }

    // -----------------------------
    // Order status check
    // -----------------------------

    const deliveryStatus = String(
      order.deliveryStatus ||
      order.status ||
      ""
    ).toLowerCase();

    if (
      deliveryStatus === "order successful" ||
      deliveryStatus === "delivered" ||
      deliveryStatus === "cancelled"
    ) {
      return res.status(409).json({
        error:
          "This order is no longer payable",
      });
    }

    // -----------------------------
    // Server-side amount
    // -----------------------------

    const total = Number(order.total);

    if (
      !Number.isFinite(total) ||
      total <= 0
    ) {
      return res.status(400).json({
        error:
          "Invalid server-side order total",
      });
    }

    const amountPaise =
      Math.round(total * 100);

    if (
      !Number.isSafeInteger(amountPaise) ||
      amountPaise < 100
    ) {
      return res.status(400).json({
        error: "Invalid payment amount",
      });
    }

    // -----------------------------
    // Razorpay credentials
    // -----------------------------

    const keyId =
      process.env.RZP_KEY_ID;

    const keySecret =
      process.env.RZP_KEY_SECRET;

    if (!keyId || !keySecret) {
      return res.status(500).json({
        error:
          "Razorpay credentials are not configured",
      });
    }

    // -----------------------------
    // Reuse existing pending order
    // -----------------------------

    if (
      order.razorpayOrderId &&
      String(order.paymentStatus || "")
        .toLowerCase() === "pending"
    ) {
      return res.status(200).json({
        success: true,
        id: order.razorpayOrderId,
        amount: amountPaise,
        currency: "INR",
        reused: true,
      });
    }

    // -----------------------------
    // Create Razorpay order
    // -----------------------------

    const basicAuth =
      Buffer.from(
        `${keyId}:${keySecret}`
      ).toString("base64");

    const razorpayResponse =
      await fetch(
        "https://api.razorpay.com/v1/orders",
        {
          method: "POST",

          headers: {
            Authorization:
              `Basic ${basicAuth}`,

            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            amount: amountPaise,

            currency: "INR",

            receipt:
              String(orderId)
                .slice(-40),

            notes: {
              firebaseOrderId:
                orderId,

              firebaseUid:
                uid,
            },
          }),
        }
      );

    let razorpayData;

    try {
      razorpayData =
        await razorpayResponse.json();
    } catch (error) {
      razorpayData = {};
    }

    if (!razorpayResponse.ok) {
      console.error(
        "Razorpay create-order error:",
        razorpayData
      );

      return res.status(502).json({
        error:
          "Unable to create Razorpay order",
      });
    }

    // -----------------------------
    // Save Razorpay order ID
    // -----------------------------

    await orderRef.update({
      razorpayOrderId:
        razorpayData.id,

      paymentAmountPaise:
        amountPaise,

      paymentCurrency:
        "INR",

      paymentStatus:
        "pending",

      paymentCreatedAt:
        Date.now(),

      deliveryStatus:
        "Awaiting Payment",
    });

    // -----------------------------
    // Response
    // -----------------------------

    return res.status(200).json({
      success: true,

      id:
        razorpayData.id,

      amount:
        razorpayData.amount,

      currency:
        razorpayData.currency,

      receipt:
        razorpayData.receipt,
    });

  } catch (error) {
    console.error(
      "create-order server error:",
      error
    );

    return res.status(500).json({
      error:
        error && error.message
          ? error.message
          : "Internal server error",
    });
  }
};
