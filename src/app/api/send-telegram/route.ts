import { readFileSync } from "fs";
import { join } from "path";

const configPath = join(process.cwd(), "src", "json", "data.json");
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const TELEGRAM_BOT_TOKEN = config.telegram_bot_token;
const USERS: { telegram_chat_id: string; active?: boolean }[] = config.users ?? [];

export async function POST(request: Request) {
  const { message } = await request.json();

  if (!message) {
    return Response.json({ error: "Missing message" }, { status: 400 });
  }

  const results = [];
  for (const user of USERS) {
    if (user.active === false) continue;
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: user.telegram_chat_id,
            text: message,
            parse_mode: "HTML",
          }),
        }
      );
      results.push(await res.json());
    } catch {
      // skip failed sends
    }
  }

  return Response.json({ ok: true, sent: results.length });
}
