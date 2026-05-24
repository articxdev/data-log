export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    // ---- KV dedup (only the last update_id is stored) ----
    if (update.update_id) {
      try {
        const last = await env.KV.get("meta:last_update_id", "text");
        if (last === String(update.update_id)) {
          return new Response("Duplicate", { status: 200 });
        }
        await env.KV.put("meta:last_update_id", String(update.update_id));
      } catch (_) {}
    }

    ctx.waitUntil(
      (async () => {
        try {
          await handleMessage(update, env);
        } catch (err) {
          console.error("Fatal:", err);
          if (update?.message?.chat?.id && env.BOT_TOKEN) {
            try {
              await fetch(
                `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    chat_id: update.message.chat.id,
                    text: "⚠️ Internal error. Check logs.",
                    parse_mode: "Markdown",
                  }),
                }
              );
            } catch (_) {}
          }
        }
      })()
    );

    return new Response("OK", { status: 200 });
  },
};

async function handleMessage(update, env) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const { BOT_TOKEN, KV, ALLOWED_USERS, PRODUCTS } = env;
  if (!BOT_TOKEN) return;

  const chatId = msg.chat.id;
  const userId = String(msg.from.id);

  const allowed = (ALLOWED_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(userId)) return;

  const text = msg.text.trim();
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  const tg = (method, body) =>
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const reply = (t, mode) =>
    tg("sendMessage", {
      chat_id: chatId,
      text: t,
      parse_mode: mode || "Markdown",
    });

  // ---- helpers ----
  const PAD = (n) => String(n).padStart(2, "0");
  const NOW = () => {
    const d = new Date();
    return `${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
  };
  const TODAY_KEY = () => {
    const d = new Date();
    return `prod:${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;
  };
  const DATE_KEY = (ds) => `prod:${ds}`;
  const SHIFT = (h) =>
    h < 6 ? "Night" : h < 14 ? "Morning" : h < 22 ? "Evening" : "Night";
  const FMT_DATE = (ds) => {
    const [y, m, d] = ds.split("-").map(Number);
    return `${d} ${"Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[m - 1]} ${y}`;
  };

  const kvGet = async (key) => {
    try {
      return await KV.get(key, "text");
    } catch {
      return null;
    }
  };
  const kvPut = async (key, val) => {
    try {
      await KV.put(key, val);
      return true;
    } catch {
      return false;
    }
  };

  const getEntries = async (key) => {
    const raw = await kvGet(key);
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      await kvPut(key, "[]");
      return [];
    }
  };

  // ---- /add ----
  if (cmd === "/add") {
    const count = parseInt(args[0], 10);
    if (!Number.isFinite(count) || count <= 0 || count > 1000000) {
      return reply("❌ Enter a valid count (1–1000000)");
    }

    const defaultProducts = (PRODUCTS || "PCB-A,IC-555,Connector")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    let activeProduct = await kvGet(`user:${userId}:active_product`);
    if (!activeProduct) activeProduct = defaultProducts[0] || "PCB-A";

    const productOverride = args.find((a) => a.startsWith("--product="));
    if (productOverride) {
      activeProduct = productOverride.split("=")[1];
      await kvPut(`user:${userId}:active_product`, activeProduct);
    }

    const shiftOverride = args.find((a) => a.startsWith("--shift="));
    const shift = shiftOverride
      ? shiftOverride.split("=")[1]
      : SHIFT(new Date().getHours());

    const dateOverride = args.find((a) => a.startsWith("--date="));
    const dateStr = dateOverride ? dateOverride.split("=")[1] : null;
    if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return reply("❌ `--date=` must be YYYY-MM-DD");
    }

    const note = args
      .slice(1)
      .filter((a) => !a.startsWith("--"))
      .join(" ")
      .trim()
      .slice(0, 200);

    const entry = {
      time: NOW(),
      count,
      shift,
      note,
      by: userId,
      product: activeProduct,
    };

    const key = dateStr ? DATE_KEY(dateStr) : TODAY_KEY();
    const entries = await getEntries(key);
    entries.push(entry);
    const ok1 = await kvPut(key, JSON.stringify(entries));

    let cur = 0;
    try {
      const r = await KV.get("stats:overall", "text");
      if (r) cur = Number(r);
    } catch {}
    const ok2 = await kvPut("stats:overall", String(cur + count));

    if (!ok1 || !ok2) return reply("⚠️ Storage error — data may not be saved.");

    const dateLabel = dateStr ? ` (${dateStr})` : "";
    return reply(
      `✅ *Logged:* ${count} pcs [${activeProduct}] at ${entry.time}${dateLabel} (${shift})${note ? " — " + note : ""}`
    );
  }

  // ---- /product ----
  if (cmd === "/product") {
    const current =
      (await kvGet(`user:${userId}:active_product`)) ||
      (PRODUCTS || "PCB-A,IC-555,Connector").split(",")[0];

    if (args.length === 0) {
      let raw = await kvGet(`user:${userId}:products`);
      let list = raw
        ? JSON.parse(raw)
        : (PRODUCTS || "PCB-A,IC-555,Connector")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
      const items = list
        .map((p) => `  ${p === current ? "•" : " "} ${p}`)
        .join("\n");
      return reply(
        `🎯 *Active product:* ${current}\n\n*Your products:*\n${items}\n\nUse \`/product <name>\` to switch.`
      );
    }

    const name = args.join(" ");
    await kvPut(`user:${userId}:active_product`, name);

    let raw = await kvGet(`user:${userId}:products`);
    let list = raw
      ? JSON.parse(raw)
      : (PRODUCTS || "PCB-A,IC-555,Connector")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    if (!list.includes(name)) {
      list.push(name);
      await kvPut(`user:${userId}:products`, JSON.stringify(list));
    }

    return reply(`✅ Switched to product: *${name}*`);
  }

  // ---- /products ----
  if (cmd === "/products") {
    const current =
      (await kvGet(`user:${userId}:active_product`)) ||
      (PRODUCTS || "PCB-A,IC-555,Connector").split(",")[0];
    let raw = await kvGet(`user:${userId}:products`);
    let list = raw
      ? JSON.parse(raw)
      : (PRODUCTS || "PCB-A,IC-555,Connector")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    const items = list
      .map((p) => `  ${p === current ? "•" : " "} ${p}`)
      .join("\n");
    return reply(`*Your products:*\n${items}\n\nActive: *${current}*`);
  }

  // ---- display helpers ----
  const entryLine = (e, i) => {
    let s = `  ${i + 1}. [${e.time}]  ${e.count} pcs`;
    if (e.product) s += ` [${e.product}]`;
    if (e.shift) s += ` (${e.shift})`;
    if (e.note) s += ` — ${e.note}`;
    return s;
  };

  const byProduct = (entries) => {
    const m = {};
    for (const e of entries) {
      const p = e.product || "(unspecified)";
      m[p] = (m[p] || 0) + e.count;
    }
    return Object.entries(m)
      .map(([p, c]) => `  ${p}: ${c} pcs`)
      .join("\n");
  };

  const dayReport = async (key, title) => {
    const entries = await getEntries(key);
    if (!entries.length) return reply(`📭 No entries ${title}.`);
    const total = entries.reduce((s, e) => s + e.count, 0);
    const lines = entries.map(entryLine).join("\n");
    return reply(
      `📅 *${title}*\n${lines}\n\n━━━━━━━━━━━\n*Total: ${total} pcs*\n\n*By product:*\n${byProduct(entries)}`
    );
  };

  // ---- /today ----
  if (cmd === "/today") {
    const d = new Date();
    const label = `${PAD(d.getDate())} ${"Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[d.getMonth()]} ${d.getFullYear()}`;
    return dayReport(TODAY_KEY(), `Today (${label})`);
  }

  // ---- /yesterday ----
  if (cmd === "/yesterday") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const label = `${PAD(d.getDate())} ${"Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[d.getMonth()]} ${d.getFullYear()}`;
    const key = DATE_KEY(
      `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`
    );
    return dayReport(key, `Yesterday (${label})`);
  }

  // ---- /date ----
  if (cmd === "/date") {
    const ds = args[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) {
      return reply("❌ Use `/date YYYY-MM-DD`");
    }
    return dayReport(DATE_KEY(ds), FMT_DATE(ds));
  }

  // ---- /week ----
  if (cmd === "/week") {
    const d = new Date();
    const day = d.getDay();
    const mon = new Date(d);
    mon.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    let total = 0;
    const lines = [];
    const cur = new Date(mon);
    while (cur <= sun) {
      const ds = `${cur.getFullYear()}-${PAD(cur.getMonth() + 1)}-${PAD(cur.getDate())}`;
      const entries = await getEntries(DATE_KEY(ds));
      const dayTotal = entries.reduce((s, e) => s + e.count, 0);
      if (dayTotal > 0) lines.push(`  ${ds}: ${dayTotal} pcs`);
      total += dayTotal;
      cur.setDate(cur.getDate() + 1);
    }
    return reply(
      `📊 *Week (${FMT_DATE(`${mon.getFullYear()}-${PAD(mon.getMonth() + 1)}-${PAD(mon.getDate())}`)} – ${FMT_DATE(`${sun.getFullYear()}-${PAD(sun.getMonth() + 1)}-${PAD(sun.getDate())}`)})*\n${lines.length ? lines.join("\n") : "  No entries"}\n\n━━━━━━━━━━━\n*Total: ${total} pcs*`
    );
  }

  // ---- /month ----
  if (cmd === "/month") {
    const d = new Date();
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const last = new Date(y, m, 0).getDate();
    const start = `${y}-${PAD(m)}-01`;
    const end = `${y}-${PAD(m)}-${PAD(last)}`;
    let total = 0;
    const lines = [];
    const cur = new Date(start);
    const endD = new Date(end);
    while (cur <= endD) {
      const ds = `${cur.getFullYear()}-${PAD(cur.getMonth() + 1)}-${PAD(cur.getDate())}`;
      const entries = await getEntries(DATE_KEY(ds));
      const dayTotal = entries.reduce((s, e) => s + e.count, 0);
      if (dayTotal > 0) lines.push(`  ${ds}: ${dayTotal} pcs`);
      total += dayTotal;
      cur.setDate(cur.getDate() + 1);
    }
    return reply(
      `📊 *Month (${FMT_DATE(start)} – ${FMT_DATE(end)})*\n${lines.length ? lines.join("\n") : "  No entries"}\n\n━━━━━━━━━━━\n*Total: ${total} pcs*`
    );
  }

  // ---- /stats ----
  if (cmd === "/stats") {
    const todayTotal = (await getEntries(TODAY_KEY())).reduce(
      (s, e) => s + e.count,
      0
    );
    const d = new Date();
    const day = d.getDay();
    const mon = new Date(d);
    mon.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    let weekTotal = 0;
    let cur = new Date(mon);
    while (cur <= sun) {
      const ds = `${cur.getFullYear()}-${PAD(cur.getMonth() + 1)}-${PAD(cur.getDate())}`;
      weekTotal += (await getEntries(DATE_KEY(ds))).reduce(
        (s, e) => s + e.count,
        0
      );
      cur.setDate(cur.getDate() + 1);
    }
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const last = new Date(y, m, 0).getDate();
    let monthTotal = 0;
    cur = new Date(`${y}-${PAD(m)}-01`);
    const mEnd = new Date(`${y}-${PAD(m)}-${PAD(last)}`);
    while (cur <= mEnd) {
      const ds = `${cur.getFullYear()}-${PAD(cur.getMonth() + 1)}-${PAD(cur.getDate())}`;
      monthTotal += (await getEntries(DATE_KEY(ds))).reduce(
        (s, e) => s + e.count,
        0
      );
      cur.setDate(cur.getDate() + 1);
    }
    let overall = 0;
    try {
      const r = await KV.get("stats:overall", "text");
      if (r) overall = Number(r);
    } catch {}
    return reply(
      `📊 *Stats*\n  Today:  ${todayTotal} pcs\n  Week:   ${weekTotal} pcs\n  Month:  ${monthTotal} pcs\n  ─────────────────\n  *Overall: ${overall} pcs*`
    );
  }

  // ---- /total ----
  if (cmd === "/total") {
    let overall = 0;
    try {
      const r = await KV.get("stats:overall", "text");
      if (r) overall = Number(r);
    } catch {}
    return reply(`🏭 *Overall Total*\n  ${overall} pcs`);
  }

  // ---- /undo ----
  if (cmd === "/undo") {
    const key = TODAY_KEY();
    const entries = await getEntries(key);
    if (!entries.length) return reply("📭 Nothing to undo.");
    const removed = entries.pop();
    const ok1 = await kvPut(key, JSON.stringify(entries));
    let cur = 0;
    try {
      const r = await KV.get("stats:overall", "text");
      if (r) cur = Number(r);
    } catch {}
    const ok2 = await kvPut("stats:overall", String(Math.max(0, cur - removed.count)));
    if (!ok1 || !ok2) return reply("⚠️ Storage error — undo may be incomplete.");
    return reply(
      `↩️ *Undone:* ${removed.count} pcs [${removed.product || "?"}] at ${removed.time}${removed.shift ? " (" + removed.shift + ")" : ""}`
    );
  }

  // ---- /export ----
  if (cmd === "/export") {
    let csv = "Date,Time,Count,Product,Shift,Note\n";
    let cursor;
    do {
      const page = await KV.list({ prefix: "prod:", limit: 1000, cursor });
      const sorted = page.keys.map((k) => k.name).sort();
      for (const key of sorted) {
        const entries = await getEntries(key);
        const date = key.slice(5);
        for (const e of entries) {
          csv += `${date},${e.time},${e.count},${e.product || ""},${e.shift || ""},${(e.note || "").replace(/,/g, ";")}\n`;
        }
      }
      cursor = page.cursor;
    } while (cursor);
    const chunk = csv.slice(0, 3900);
    const note = csv.length > 3900 ? `\n_(truncated — ${csv.length} chars)_` : "";
    return reply(`📎 *Export CSV*\n\`\`\`\n${chunk}\n\`\`\`${note}`);
  }

  // ---- /repair ----
  if (cmd === "/repair") {
    await reply("🔄 Recalculating overall total from raw data…");
    let total = 0;
    let cursor;
    do {
      const page = await KV.list({ prefix: "prod:", limit: 1000, cursor });
      for (const { name: key } of page.keys) {
        const entries = await getEntries(key);
        for (const e of entries) {
          if (e && typeof e.count === "number") total += e.count;
        }
      }
      cursor = page.cursor;
    } while (cursor);
    await KV.put("stats:overall", String(total));
    return reply(`✅ *Repaired.* Overall total: ${total} pcs`);
  }

  // ---- /start /help ----
  if (cmd === "/start" || cmd === "/help") {
    return reply(`📋 *Production Log Bot*

*Commands*
/add <count> [note]                    — Log (uses active product)
/add <count> --product=NAME            — Log with specific product
/add <count> --date=YYYY-MM-DD         — Log to a past date
/add <count> --shift=Morning/Night     — Override shift
/product                               — Show active product
/product <name>                        — Switch product
/products                              — List all products
/today                                 — Today's entries & breakdown
/yesterday                             — Yesterday's entries
/date YYYY-MM-DD                       — Entries for any date
/week                                  — Week summary
/month                                 — Month summary
/stats                                 — Quick summary
/total                                 — Lifetime total
/undo                                  — Remove last entry
/export                                — Export CSV
/repair                                — Recalculate totals
/help                                  — This message

*Examples*
/add 150
/add 320 --shift=Night --date=2026-05-20 --product=IC-555
/product PCB-A`);
  }

  return reply("❓ Unknown command. Send /help");
}
