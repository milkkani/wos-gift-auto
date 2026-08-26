const SOURCE_CHANNEL = "1542165450207527094";
const RESULT_CHANNEL = "1542167671154409563";
const PLAYER_ID = "441788306";
const KINGDOM_ID = "3338";
const WOS_API = "https://wos-giftcode-api.centurygame.com/api/gift_code";
const WOS_KEY = "tB87#kPtkxqOS2";

export default {
  async fetch() {
    return Response.json({
      ok: true,
      message: "ホワサバ自動ギフトコードBotは待機中です",
    });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(checkDiscord(env));
  },
};

async function checkDiscord(env) {
  if (!env.DISCORD_BOT_TOKEN) {
    throw new Error("DISCORD_BOT_TOKEN が未設定です");
  }

  const response = await fetch(
    `https://discord.com/api/v10/channels/${SOURCE_CHANNEL}/messages?limit=20`,
    {
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "User-Agent": "WOSGiftAuto (https://workers.cloudflare.com, 1.0)",
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Discord読取エラー: HTTP ${response.status}`);
  }

  const messages = await response.json();
  const codes = new Set();

  for (const message of [...messages].reverse()) {
    const text = [
      message.content || "",
      ...(message.embeds || []).flatMap((embed) => [
        embed.title || "",
        embed.description || "",
        ...(embed.fields || []).map(
          (field) => `${field.name} ${field.value}`,
        ),
      ]),
    ].join("\n");

    for (const match of text.matchAll(
      /(?:gift\s*code|code)\s*[:：]\s*([A-Za-z0-9_-]{4,64})/gi,
    )) {
      codes.add(match[1]);
    }
  }

  for (const code of codes) {
    await processCode(code, env);
  }
}

async function processCode(code, env) {
  const cache = caches.default;
  const cacheKey = new Request(
    `https://wos-gift-auto.invalid/processed/${encodeURIComponent(code)}`,
  );

  if (await cache.match(cacheKey)) return;

  const result = await redeem(code);

  const terminalCodes = new Set([
    "20000",
    "40005",
    "40006",
    "40007",
    "40008",
    "40010",
    "40011",
    "40014",
    "40020",
  ]);

  if (terminalCodes.has(result.errCode)) {
    await cache.put(
      cacheKey,
      new Response("processed", {
        headers: {
          "Cache-Control": "public, max-age=2592000",
        },
      }),
    );
  }

  if (result.errCode === "20000") {
    await sendDiscord(
      env,
      `✅ **ギフトコードを自動受取しました**
コード：\`${code}\`
プレイヤーID：\`${PLAYER_ID}\`
報酬はゲーム内メールを確認してください。`,
    );
  }
}

async function redeem(code) {
  const time = Math.floor(Date.now() / 1000).toString();

  const sign = md5(
    `cdk=${code}&fid=${PLAYER_ID}&kid=${KINGDOM_ID}&time=${time}${WOS_KEY}`,
  );

  const body = new URLSearchParams({
    cdk: code,
    fid: PLAYER_ID,
    kid: KINGDOM_ID,
    time,
    sign,
  });

  const response = await fetch(WOS_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
      Origin: "https://wos-giftcode.centurygame.com",
      Referer: "https://wos-giftcode.centurygame.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36",
    },
    body: body.toString(),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`ホワサバAPIエラー: HTTP ${response.status}`);
  }

  const data = JSON.parse(text);

  return {
    errCode: String(data.err_code ?? ""),
    message: data.msg ?? "",
  };
}

async function sendDiscord(env, content) {
  const response = await fetch(
    `https://discord.com/api/v10/channels/${RESULT_CHANNEL}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "WOSGiftAuto (https://workers.cloudflare.com, 1.0)",
      },
      body: JSON.stringify({ content }),
    },
  );

  if (!response.ok) {
    throw new Error(`Discord送信エラー: HTTP ${response.status}`);
  }
}

function md5(input) {
  const add = (a, b) => (a + b) & 0xffffffff;

  const cmn = (q, a, b, x, s, t) => {
    const n = add(add(a, q), add(x, t));
    return add((n << s) | (n >>> (32 - s)), b);
  };

  const ff = (a,b,c,d,x,s,t) =>
    cmn((b&c)|(~b&d),a,b,x,s,t);
  const gg = (a,b,c,d,x,s,t) =>
    cmn((b&d)|(c&~d),a,b,x,s,t);
  const hh = (a,b,c,d,x,s,t) =>
    cmn(b^c^d,a,b,x,s,t);
  const ii = (a,b,c,d,x,s,t) =>
    cmn(c^(b|~d),a,b,x,s,t);

  const bytes = new TextEncoder().encode(input);
  const len = bytes.length;
  const total = (((len + 8) >>> 6) + 1) * 16;
  const x = new Array(total).fill(0);

  for (let i = 0; i < len; i++) {
    x[i >> 2] |= bytes[i] << ((i % 4) * 8);
  }

  x[len >> 2] |= 0x80 << ((len % 4) * 8);
  x[total - 2] = len * 8;

  let A=1732584193;
  let B=-271733879;
  let C=-1732584194;
  let D=271733878;

  for(let j=0;j<x.length;j+=16) {
    let a=A,b=B,c=C,d=D;

    a=ff(a,b,c,d,x[j],7,-680876936);
    d=ff(d,a,b,c,x[j+1],12,-389564586);
    c=ff(c,d,a,b,x[j+2],17,606105819);
    b=ff(b,c,d,a,x[j+3],22,-1044525330);
    a=ff(a,b,c,d,x[j+4],7,-176418897);
    d=ff(d,a,b,c,x[j+5],12,1200080426);
    c=ff(c,d,a,b,x[j+6],17,-1473231341);
    b=ff(b,c,d,a,x[j+7],22,-45705983);
    a=ff(a,b,c,d,x[j+8],7,1770035416);
    d=ff(d,a,b,c,x[j+9],12,-1958414417);
    c=ff(c,d,a,b,x[j+10],17,-42063);
    b=ff(b,c,d,a,x[j+11],22,-1990404162);
    a=ff(a,b,c,d,x[j+12],7,1804603682);
    d=ff(d,a,b,c,x[j+13],12,-40341101);
    c=ff(c,d,a,b,x[j+14],17,-1502002290);
    b=ff(b,c,d,a,x[j+15],22,1236535329);

    a=gg(a,b,c,d,x[j+1],5,-165796510);
    d=gg(d,a,b,c,x[j+6],9,-1069501632);
    c=gg(c,d,a,b,x[j+11],14,643717713);
    b=gg(b,c,d,a,x[j],20,-373897302);
    a=gg(a,b,c,d,x[j+5],5,-701558691);
    d=gg(d,a,b,c,x[j+10],9,38016083);
    c=gg(c,d,a,b,x[j+15],14,-660478335);
    b=gg(b,c,d,a,x[j+4],20,-405537848);
    a=gg(a,b,c,d,x[j+9],5,568446438);
    d=gg(d,a,b,c,x[j+14],9,-1019803690);
    c=gg(c,d,a,b,x[j+3],14,-187363961);
    b=gg(b,c,d,a,x[j+8],20,1163531501);
    a=gg(a,b,c,d,x[j+13],5,-1444681467);
    d=gg(d,a,b,c,x[j+2],9,-51403784);
    c=gg(c,d,a,b,x[j+7],14,1735328473);
    b=gg(b,c,d,a,x[j+12],20,-1926607734);

    a=hh(a,b,c,d,x[j+5],4,-378558);
    d=hh(d,a,b,c,x[j+8],11,-2022574463);
    c=hh(c,d,a,b,x[j+11],16,1839030562);
    b=hh(b,c,d,a,x[j+14],23,-35309556);
    a=hh(a,b,c,d,x[j+1],4,-1530992060);
    d=hh(d,a,b,c,x[j+4],11,1272893353);
    c=hh(c,d,a,b,x[j+7],16,-155497632);
    b=hh(b,c,d,a,x[j+10],23,-1094730640);
    a=hh(a,b,c,d,x[j+13],4,681279174);
    d=hh(d,a,b,c,x[j],11,-358537222);
    c=hh(c,d,a,b,x[j+3],16,-722521979);
    b=hh(b,c,d,a,x[j+6],23,76029189);
    a=hh(a,b,c,d,x[j+9],4,-640364487);
    d=hh(d,a,b,c,x[j+12],11,-421815835);
    c=hh(c,d,a,b,x[j+15],16,530742520);
    b=hh(b,c,d,a,x[j+2],23,-995338651);

    a=ii(a,b,c,d,x[j],6,-198630844);
    d=ii(d,a,b,c,x[j+7],10,1126891415);
    c=ii(c,d,a,b,x[j+14],15,-1416354905);
    b=ii(b,c,d,a,x[j+5],21,-57434055);
    a=ii(a,b,c,d,x[j+12],6,1700485571);
    d=ii(d,a,b,c,x[j+3],10,-1894986606);
    c=ii(c,d,a,b,x[j+10],15,-1051523);
    b=ii(b,c,d,a,x[j+1],21,-2054922799);
    a=ii(a,b,c,d,x[j+8],6,1873313359);
    d=ii(d,a,b,c,x[j+15],10,-30611744);
    c=ii(c,d,a,b,x[j+6],15,-1560198380);
    b=ii(b,c,d,a,x[j+13],21,1309151649);
    a=ii(a,b,c,d,x[j+4],6,-145523070);
    d=ii(d,a,b,c,x[j+11],10,-1120210379);
    c=ii(c,d,a,b,x[j+2],15,718787259);
    b=ii(b,c,d,a,x[j+9],21,-343485551);

    A=add(A,a);
    B=add(B,b);
    C=add(C,c);
    D=add(D,d);
  }

  return [A,B,C,D]
    .map((n) =>
      [0,8,16,24]
        .map((s) =>
          ((n>>>s)&255).toString(16).padStart(2,"0"),
        )
        .join(""),
    )
    .join("");
}
