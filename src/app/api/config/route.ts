import { readFileSync } from "fs";
import { join } from "path";

const configPath = join(process.cwd(), "src", "json", "data.json");

export async function GET() {
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  const users = (config.users ?? []).filter((u: { active?: boolean }) => u.active !== false);

  return Response.json({
    ok: true,
    users: users.map((u: { name: string; oi_threshold: Record<string, number> | number }) => ({
      name: u.name,
      oi_threshold: u.oi_threshold,
    })),
  });
}
