const TELEGRAM_BOT_TOKEN = "8882164490:AAEmber4ZZocHVe-nXmX-oHaKza3slZYd9s";
const TELEGRAM_CHAT_ID = "8503524860";

export async function POST(request: Request) {
  const { message } = await request.json();

  if (!message) {
    return Response.json({ error: "Missing message" }, { status: 400 });
  }

  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
      }),
    }
  );

  const data = await res.json();
  return Response.json(data);
}
