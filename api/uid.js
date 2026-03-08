export default async function handler(req, res) {
  const { uid } = req.query;
  if (!uid || !/^\d{9,10}$/.test(uid)) {
    return res.status(400).json({ error: 'Invalid UID' });
  }
  try {
    const response = await fetch(`https://enka.network/api/uid/${uid}`, {
      headers: {
        'User-Agent': 'EnkaVerse/3.0',
        'Accept': 'application/json',
      }
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
