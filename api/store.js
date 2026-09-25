// api/store.js (Vercel Serverless Function)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const dbUrl = "https://manorbiryani-default-rtdb.firebaseio.com/";
    
    const [settingsRes, categoriesRes] = await Promise.all([
      fetch(dbUrl + "settings.json"),
      fetch(dbUrl + "categories.json")
    ]);

    const settings = await settingsRes.json();
    const categories = await categoriesRes.json();

    // Sensitive PIN ko server par hi remove kar rahe hain taaki client ko na mile
    if (settings && settings.pin) {
      delete settings.pin;
    }

    return res.status(200).json({
      success: true,
      settings: settings || {},
      categories: categories || {}
    });

  } catch (error) {
    return res.status(500).json({ 
      success: false, 
      error: "Failed to fetch store data securely." 
    });
  }
}
