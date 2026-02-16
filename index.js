import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Home test
app.get("/", (req, res) => {
  res.send("Lucky77 Bot API Running");
});

// Simple test endpoint
app.post("/test", (req, res) => {
  const user = req.body;

  if (!user) {
    return res.json({ message: "No user data" });
  }

  const name = `${user.first_name || ""} ${user.last_name || ""}`.trim() || "Unknown";

  res.json({
    success: true,
    name: name,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
