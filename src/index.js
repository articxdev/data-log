export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("OK", { status: 200 });

    const token = env.BOT_TOKEN;
    if (!token) return new Response("No BOT_TOKEN", { status: 500 });

    const allowed = (env.ALLOWED_USERS || "").split(",").map(s => s.trim()).filter(Boolean);

    let update;
    try { update = await request.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

    ctx.waitUntil((async () => {
      try {
        const msg = update.message;
        if (!msg || !msg.text) return;

        const userId = String(msg.from.id);
        if (allowed.length && !allowed.includes(userId)) return;

        const chatId = msg.chat.id;
        const txt = msg.text.trim();
        const parts = txt.split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);

        const prodKey = (d) => {
          const y = d.getFullYear();
          const m = String(d.getMonth()+1).padStart(2,"0");
          const day = String(d.getDate()).padStart(2,"0");
          return `prod:${y}-${m}-${day}`;
        };

        const reply = async (text) => {
          try {
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
            });
          } catch (e) { console.error("reply error", e); }
        };

        if (cmd === "/start" || cmd === "/help") {
          return reply("📋 *Production Log Bot*\n\n/add <count> — Log production\n/today — Today's entries\n/stats — Summary\n/help — This message");
        }

        if (cmd === "/add") {
          const count = parseInt(args[0], 10);
          if (!Number.isFinite(count) || count <= 0) return reply("❌ Enter a valid number");

          const now = new Date();
          const time = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
          const key = prodKey(now);

          let entries = [];
          try {
            const raw = await env.KV.get(key, "text");
            if (raw) entries = JSON.parse(raw);
          } catch (e) { console.error("kv get", e); }

          entries.push({ time, count });
          try { await env.KV.put(key, JSON.stringify(entries)); } catch (e) { console.error("kv put", e); return reply("⚠️ Storage error"); }

          let total = 0;
          try { const r = await env.KV.get("stats:overall", "text"); if (r) total = Number(r); } catch {}
          try { await env.KV.put("stats:overall", String(total + count)); } catch {}

          return reply(`✅ Logged: ${count} pcs at ${time}`);
        }

        if (cmd === "/today") {
          const key = prodKey(new Date());
          let entries = [];
          try { const raw = await env.KV.get(key, "text"); if (raw) entries = JSON.parse(raw); } catch {}
          if (!entries.length) return reply("📭 No entries today");
          const total = entries.reduce((s, e) => s + e.count, 0);
          const lines = entries.map((e, i) => `  ${i+1}. [${e.time}]  ${e.count} pcs`).join("\n");
          return reply(`📅 *Today*\n${lines}\n\nTotal: ${total} pcs`);
        }

        if (cmd === "/stats") {
          let overall = 0;
          try { const r = await env.KV.get("stats:overall", "text"); if (r) overall = Number(r); } catch {}
          return reply(`📊 *Total overall:* ${overall} pcs`);
        }

        if (cmd === "/total") {
          let overall = 0;
          try { const r = await env.KV.get("stats:overall", "text"); if (r) overall = Number(r); } catch {}
          return reply(`🏭 *Overall Total:* ${overall} pcs`);
        }

        return reply("Unknown. Send /help");
      } catch (err) {
        console.error("FATAL:", err);
        try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: update?.message?.chat?.id || 0, text: "⚠️ Internal error" }) }); } catch {}
      }
    })());

    return new Response("OK", { status: 200 });
  },
};
