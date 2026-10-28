import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? "8080");
const app = await createApp();
app.listen(port, "0.0.0.0", () => {
  console.log(`Stockroom Node API listening on port ${port}`);
});
