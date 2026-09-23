const SOURCE_CHANNEL = "1542165450207527094";
const RESULT_CHANNEL = "1542167671154409563";

/*
 * 登録情報の変更申請を送るDiscordチャンネル
 */
const CHANGE_REQUEST_CHANNEL = "1552354610021408768";

const WOS_API =
  "https://wos-giftcode-api.centurygame.com/api/gift_code";

const WOS_KEY = "tB87#kPtkxqOS2";


/*
 * 新しく登録した人にも必ず適用する常設コード。
 */
const PERMANENT_CODES = [
  "GuDokYTKOR",
  "2ndYoutubeKR",
  "1stYoutubeKR",
  "gogoWOS",
];


/*
 * 1回のCronで処理する最大人数。
 */
const MAX_MEMBERS_PER_RUN = 10;


/*
 * 1人あたりの通信タイムアウト
 */
const REDEEM_TIMEOUT_MS = 12000;



export default {

  async fetch(request, env) {

    await ensureDatabase(env);

    const url =
      new URL(request.url);


    /*
     * 新規登録
     */
    if (
      request.method === "POST" &&
      url.pathname === "/register"
    ) {
      return registerMember(
        request,
        env,
      );
    }


    /*
     * 登録情報確認ページ
     */
    if (
      request.method === "GET" &&
      url.pathname === "/manage"
    ) {

      return new Response(
        MANAGE_PAGE,
        {
          headers: {
            "Content-Type":
              "text/html; charset=UTF-8",
          },
        },
      );
    }


    /*
     * 登録情報を検索
     */
    if (
      request.method === "POST" &&
      url.pathname === "/lookup-member"
    ) {

      return lookupMember(
        request,
        env,
      );
    }


    /*
     * 変更申請
     */
    if (
      request.method === "POST" &&
      url.pathname === "/change-request"
    ) {

      return createChangeRequest(
        request,
        env,
      );
    }


    /*
     * トップページ
     */
    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {

      return new Response(
        REGISTRATION_PAGE,
        {
          headers: {
            "Content-Type":
              "text/html; charset=UTF-8",
          },
        },
      );
    }


    return new Response(
      "Not Found",
      {
        status: 404,
      },
    );
  },


  async scheduled(
    _controller,
    env,
    ctx,
  ) {

    ctx.waitUntil(

      runScheduled(env)
        .catch((error) => {

          console.error(
            "scheduled error:",
            error,
          );

        }),

    );
  },
};



/* =========================================================
   Cron
========================================================= */

async function runScheduled(env) {

  await ensureDatabase(env);


  /*
   * 変更申請の承認・却下を確認
   */
  try {

    await checkChangeRequestCommands(
      env,
    );

  } catch (error) {

    console.error(
      "checkChangeRequestCommands error:",
      error,
    );
  }


  /*
   * ギフトコード確認
   */
  try {

    await checkDiscord(env);

  } catch (error) {

    console.error(
      "checkDiscord error:",
      error,
    );
  }
}



/* =========================================================
   Database
========================================================= */

async function ensureDatabase(env) {

  if (!env.MEMBERS_DB) {

    throw new Error(
      "MEMBERS_DB が未設定です",
    );
  }


  await env.MEMBERS_DB.batch([

    /*
     * 古いTriggerを削除
     */
    env.MEMBERS_DB.prepare(`
      DROP TRIGGER IF EXISTS
      reopen_recent_codes_for_new_member
    `),


    /*
     * 登録者
     */
    env.MEMBERS_DB.prepare(`
      CREATE TABLE IF NOT EXISTS members (

        id INTEGER
          PRIMARY KEY
          AUTOINCREMENT,

        player_name TEXT
          NOT NULL,

        player_id TEXT
          NOT NULL,

        kingdom_id TEXT
          NOT NULL,

        active INTEGER
          NOT NULL
          DEFAULT 1,

        created_at TEXT
          NOT NULL
          DEFAULT CURRENT_TIMESTAMP,

        UNIQUE(
          player_id,
          kingdom_id
        )
      )
    `),


    /*
     * ギフトコード受取履歴
     */
    env.MEMBERS_DB.prepare(`
      CREATE TABLE IF NOT EXISTS processed_codes (

        code TEXT
          NOT NULL,

        member_id INTEGER
          NOT NULL,

        err_code TEXT
          NOT NULL,

        message TEXT,

        processed_at TEXT
          NOT NULL
          DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY(
          code,
          member_id
        )
      )
    `),


    /*
     * ギフトコード処理キュー
     */
    env.MEMBERS_DB.prepare(`
      CREATE TABLE IF NOT EXISTS code_jobs (

        code TEXT
          PRIMARY KEY,

        created_at TEXT
          NOT NULL
          DEFAULT CURRENT_TIMESTAMP,

        notified INTEGER
          NOT NULL
          DEFAULT 0,

        locked_until INTEGER
          NOT NULL
          DEFAULT 0
      )
    `),


    /*
     * 登録情報変更申請
     *
     * members本体を書き換えるので、
     * 変更後に古い登録が別件として
     * 残ることはない。
     *
     * このテーブルには
     * 「何から何へ変更したか」
     * という履歴だけ残る。
     */
    env.MEMBERS_DB.prepare(`
      CREATE TABLE IF NOT EXISTS change_requests (

        id INTEGER
          PRIMARY KEY
          AUTOINCREMENT,

        member_id INTEGER
          NOT NULL,

        old_player_name TEXT
          NOT NULL,

        old_player_id TEXT
          NOT NULL,

        old_kingdom_id TEXT
          NOT NULL,

        new_player_name TEXT
          NOT NULL,

        new_player_id TEXT
          NOT NULL,

        new_kingdom_id TEXT
          NOT NULL,

        status TEXT
          NOT NULL
          DEFAULT 'pending',

        discord_message_id TEXT,

        created_at TEXT
          NOT NULL
          DEFAULT CURRENT_TIMESTAMP,

        resolved_at TEXT
      )
    `),

  ]);


  /*
   * 管理者アカウント
   */
  await env.MEMBERS_DB.prepare(`
    INSERT OR IGNORE INTO members
    (
      player_name,
      player_id,
      kingdom_id
    )
    VALUES (?, ?, ?)
  `)

    .bind(
      "シュガー",
      "441788306",
      "3338",
    )

    .run();
}



/* =========================================================
   新規登録
========================================================= */

async function registerMember(
  request,
  env,
) {

  const form =
    await request.formData();


  const playerName =
    String(
      form.get(
        "player_name",
      ) || "",
    ).trim();


  const playerId =
    String(
      form.get(
        "player_id",
      ) || "",
    ).trim();


  const kingdomId =
    String(
      form.get(
        "kingdom_id",
      ) || "",
    ).trim();


  /*
   * 入力チェック
   */
  const validationError =
    validateMemberFields(
      playerName,
      playerId,
      kingdomId,
    );


  if (validationError) {

    return pageMessage(
      "登録できません",
      validationError,
      false,
    );
  }


  /*
   * 登録人数
   */
  const count =
    await env.MEMBERS_DB
      .prepare(`
        SELECT
          COUNT(*) AS total
        FROM members
        WHERE active = 1
      `)
      .first();


  if (
    Number(
      count?.total || 0,
    ) >= 500
  ) {

    return pageMessage(
      "登録できません",
      "登録上限に達しています。管理者へ連絡してください。",
      false,
    );
  }


  try {

    await env.MEMBERS_DB.prepare(`
      INSERT INTO members
      (
        player_name,
        player_id,
        kingdom_id
      )
      VALUES (?, ?, ?)
    `)

      .bind(
        playerName,
        playerId,
        kingdomId,
      )

      .run();

  } catch (error) {

    if (
      String(error)
        .includes(
          "UNIQUE",
        )
    ) {

      return pageMessage(
        "登録済みです",
        "このプレイヤーIDと王国番号はすでに登録されています。",
        true,
      );
    }


    throw error;
  }


  return pageMessage(

    "登録完了！",

    `${escapeHtml(
      playerName,
    )}さんを王国${escapeHtml(
      kingdomId,
    )}で登録しました。約1分後から常設コードと現在有効なギフトコードを順番に自動受取します。`,

    true,
  );
}



/* =========================================================
   登録情報入力チェック
========================================================= */

function validateMemberFields(
  playerName,
  playerId,
  kingdomId,
) {

  if (
    playerName.length < 1 ||
    playerName.length > 30
  ) {

    return (
      "名前は1〜30文字で入力してください。"
    );
  }


  if (
    !/^\d{6,15}$/
      .test(playerId)
  ) {

    return (
      "プレイヤーIDは6〜15桁の数字で入力してください。"
    );
  }


  if (
    !/^\d{1,6}$/
      .test(kingdomId) ||
    Number(kingdomId) < 1
  ) {

    return (
      "王国番号を数字で入力してください。"
    );
  }


  return "";
}



/* =========================================================
   登録情報を検索
========================================================= */

async function lookupMember(
  request,
  env,
) {

  const form =
    await request.formData();


  const playerId =
    String(
      form.get(
        "player_id",
      ) || "",
    ).trim();


  const kingdomId =
    String(
      form.get(
        "kingdom_id",
      ) || "",
    ).trim();


  /*
   * ID + 王国番号が一致する
   * 現在有効な登録を探す
   */
  const member =
    await env.MEMBERS_DB
      .prepare(`
        SELECT
          id,
          player_name,
          player_id,
          kingdom_id

        FROM members

        WHERE
          player_id = ?
          AND kingdom_id = ?
          AND active = 1

        LIMIT 1
      `)

      .bind(
        playerId,
        kingdomId,
      )

      .first();


  if (!member) {

    return pageMessage(

      "登録が見つかりません",

      "入力したプレイヤーID・王国番号の登録は見つかりませんでした。",

      false,
    );
  }


  /*
   * 同じ登録者から既に申請が出ていないか
   */
  const pending =
    await env.MEMBERS_DB
      .prepare(`
        SELECT id

        FROM change_requests

        WHERE
          member_id = ?
          AND status = 'pending'

        LIMIT 1
      `)

      .bind(
        member.id,
      )

      .first();


  if (pending) {

    return pageMessage(

      "変更申請中です",

      `現在、変更申請 #${pending.id} が管理者の承認待ちです。`,

      true,
    );
  }


  /*
   * 現在の登録情報を入力済みの状態で
   * 編集画面を表示
   */
  return new Response(

    editMemberPage(
      member,
    ),

    {
      headers: {
        "Content-Type":
          "text/html; charset=UTF-8",
      },
    },
  );
}



/* =========================================================
   変更申請を作成
========================================================= */

async function createChangeRequest(
  request,
  env,
) {

  const form =
    await request.formData();


  const memberId =
    Number(
      form.get(
        "member_id",
      ),
    );


  /*
   * 検索した時点の情報。
   *
   * 途中で登録情報が変わっていないか
   * 確認するために使う。
   */
  const oldPlayerId =
    String(
      form.get(
        "old_player_id",
      ) || "",
    ).trim();


  const oldKingdomId =
    String(
      form.get(
        "old_kingdom_id",
      ) || "",
    ).trim();


  /*
   * ユーザーが変更後として入力した情報
   */
  const newPlayerName =
    String(
      form.get(
        "player_name",
      ) || "",
    ).trim();


  const newPlayerId =
    String(
      form.get(
        "player_id",
      ) || "",
    ).trim();


  const newKingdomId =
    String(
      form.get(
        "kingdom_id",
      ) || "",
    ).trim();


  const validationError =
    validateMemberFields(
      newPlayerName,
      newPlayerId,
      newKingdomId,
    );


  if (validationError) {

    return pageMessage(
      "申請できません",
      validationError,
      false,
    );
  }


  /*
   * 元の登録をもう一度確認
   */
  const member =
    await env.MEMBERS_DB
      .prepare(`
        SELECT
          id,
          player_name,
          player_id,
          kingdom_id

        FROM members

        WHERE
          id = ?
          AND player_id = ?
          AND kingdom_id = ?
          AND active = 1

        LIMIT 1
      `)

      .bind(
        memberId,
        oldPlayerId,
        oldKingdomId,
      )

      .first();


  if (!member) {

    return pageMessage(

      "申請できません",

      "登録情報が途中で変更されたか、登録が見つかりませんでした。最初からやり直してください。",

      false,
    );
  }


  /*
   * 何も変更されていない
   */
  if (
    String(
      member.player_name,
    ) === newPlayerName &&

    String(
      member.player_id,
    ) === newPlayerId &&

    String(
      member.kingdom_id,
    ) === newKingdomId
  ) {

    return pageMessage(

      "変更内容がありません",

      "現在の登録情報と同じです。変更したい項目を書き換えてください。",

      false,
    );
  }


  /*
   * 変更後のID + 王国番号が
   * 他の登録者と重複していないか確認
   */
  const duplicate =
    await env.MEMBERS_DB
      .prepare(`
        SELECT id

        FROM members

        WHERE
          player_id = ?
          AND kingdom_id = ?
          AND id <> ?
          AND active = 1

        LIMIT 1
      `)

      .bind(
        newPlayerId,
        newKingdomId,
        member.id,
      )

      .first();


  if (duplicate) {

    return pageMessage(

      "申請できません",

      "変更後のプレイヤーID・王国番号は、すでに別の登録で使用されています。",

      false,
    );
  }


  /*
   * 既に承認待ちの申請があるか確認
   */
  const existingPending =
    await env.MEMBERS_DB
      .prepare(`
        SELECT id

        FROM change_requests

        WHERE
          member_id = ?
          AND status = 'pending'

        LIMIT 1
      `)

      .bind(
        member.id,
      )

      .first();


  if (existingPending) {

    return pageMessage(

      "変更申請中です",

      `すでに変更申請 #${existingPending.id} が承認待ちです。`,

      true,
    );
  }


  /*
   * 変更申請を保存
   */
  const inserted =
    await env.MEMBERS_DB
      .prepare(`
        INSERT INTO change_requests
        (
          member_id,

          old_player_name,
          old_player_id,
          old_kingdom_id,

          new_player_name,
          new_player_id,
          new_kingdom_id
        )

        VALUES (
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?
        )
      `)

      .bind(

        member.id,

        member.player_name,
        member.player_id,
        member.kingdom_id,

        newPlayerName,
        newPlayerId,
        newKingdomId,
      )

      .run();


  const requestId =
    Number(
      inserted?.meta
        ?.last_row_id || 0,
    );


  /*
   * Discordに送る申請内容
   */
  const discordText =

    `📝 **登録情報の変更申請 #${requestId}**

**変更前**
名前：${member.player_name}
王国：${member.kingdom_id}
ID：${member.player_id}

**変更後**
名前：${newPlayerName}
王国：${newKingdomId}
ID：${newPlayerId}

承認する場合：
\`承認 ${requestId}\`

却下する場合：
\`却下 ${requestId}\``;


  try {

    const discordMessage =
      await sendDiscordToChannel(

        env,

        CHANGE_REQUEST_CHANNEL,

        discordText,
      );


    /*
     * Discord側のメッセージIDも保存
     */
    if (
      discordMessage?.id
    ) {

      await env.MEMBERS_DB
        .prepare(`
          UPDATE change_requests

          SET
            discord_message_id = ?

          WHERE id = ?
        `)

        .bind(
          String(
            discordMessage.id,
          ),

          requestId,
        )

        .run();
    }

  } catch (error) {

    /*
     * Discordへ申請を送れなかった場合、
     * DBだけに申請を残すと
     * 管理者が気付けない。
     *
     * そのためpending申請を削除して
     * ユーザーに再申請してもらう。
     */
    await env.MEMBERS_DB
      .prepare(`
        DELETE FROM change_requests

        WHERE
          id = ?
          AND status = 'pending'
      `)

      .bind(
        requestId,
      )

      .run();


    console.error(
      "change request discord error:",
      error,
    );


    return pageMessage(

      "申請を送れませんでした",

      "Discordへの送信に失敗しました。少し時間を置いてもう一度お試しください。",

      false,
    );
  }


  return pageMessage(

    "変更申請を送りました",

    `申請番号は #${requestId} です。管理者が承認すると登録情報が更新されます。`,

    true,
  );
}

/* =========================================================
   Discordで変更申請の承認・却下を確認
========================================================= */

async function checkChangeRequestCommands(
  env,
) {

  if (!env.DISCORD_BOT_TOKEN) {

    throw new Error(
      "DISCORD_BOT_TOKEN が未設定です",
    );
  }


  /*
   * 変更申請チャンネルの直近50件を取得
   */
  const response =
    await fetch(

      `https://discord.com/api/v10/channels/${CHANGE_REQUEST_CHANNEL}/messages?limit=50`,

      {
        headers: {

          Authorization:
            `Bot ${env.DISCORD_BOT_TOKEN}`,

          "User-Agent":
            "WOSGiftAuto (Cloudflare Workers, 3.0)",
        },
      },
    );


  if (!response.ok) {

    throw new Error(
      `変更申請チャンネル読取エラー: HTTP ${response.status}`,
    );
  }


  const messages =
    await response.json();


  /*
   * 古いメッセージから順番に確認
   */
  for (
    const message of
      [...messages].reverse()
  ) {

    /*
     * Bot自身のメッセージは無視
     */
    if (
      message.author?.bot
    ) {
      continue;
    }


    const content =
      String(
        message.content || "",
      ).trim();


    /*
     * 対応形式
     *
     * 承認 12
     * 承認12
     * 承認 #12
     *
     * 却下 12
     * 却下12
     * 却下 #12
     */
    const match =
      content.match(
        /^(承認|却下)\s*#?(\d+)$/,
      );


    if (!match) {
      continue;
    }


    const action =
      match[1];


    const requestId =
      Number(
        match[2],
      );


    /*
     * pending状態の申請だけ取得
     *
     * 既に承認・却下済みなら
     * 次回Cronでも何もしない。
     */
    const changeRequest =
      await env.MEMBERS_DB
        .prepare(`
          SELECT
            id,
            member_id,

            old_player_name,
            old_player_id,
            old_kingdom_id,

            new_player_name,
            new_player_id,
            new_kingdom_id,

            status

          FROM change_requests

          WHERE
            id = ?
            AND status = 'pending'

          LIMIT 1
        `)

        .bind(
          requestId,
        )

        .first();


    if (!changeRequest) {

      continue;
    }


    /*
     * 却下
     */
    if (
      action === "却下"
    ) {

      const result =
        await env.MEMBERS_DB
          .prepare(`
            UPDATE change_requests

            SET
              status = 'rejected',
              resolved_at =
                CURRENT_TIMESTAMP

            WHERE
              id = ?
              AND status = 'pending'
          `)

          .bind(
            requestId,
          )

          .run();


      const changed =
        Number(
          result?.meta?.changes ??
          result?.changes ??
          0,
        );


      /*
       * 他のCronが先に処理した場合は
       * 二重通知しない
       */
      if (
        changed === 0
      ) {
        continue;
      }


      await sendDiscordToChannel(

        env,

        CHANGE_REQUEST_CHANNEL,

        `❌ **変更申請 #${requestId} を却下しました。**

登録情報は変更されていません。`,
      );


      continue;
    }


    /*
     * =====================================================
     * 承認
     * =====================================================
     */


    /*
     * 現在のmembers情報を取得
     */
    const currentMember =
      await env.MEMBERS_DB
        .prepare(`
          SELECT
            id,
            player_name,
            player_id,
            kingdom_id

          FROM members

          WHERE
            id = ?
            AND active = 1

          LIMIT 1
        `)

        .bind(
          changeRequest.member_id,
        )

        .first();


    /*
     * 元の登録が消えていた場合
     */
    if (!currentMember) {

      const result =
        await env.MEMBERS_DB
          .prepare(`
            UPDATE change_requests

            SET
              status = 'error',
              resolved_at =
                CURRENT_TIMESTAMP

            WHERE
              id = ?
              AND status = 'pending'
          `)

          .bind(
            requestId,
          )

          .run();


      const changed =
        Number(
          result?.meta?.changes ??
          result?.changes ??
          0,
        );


      if (
        changed > 0
      ) {

        await sendDiscordToChannel(

          env,

          CHANGE_REQUEST_CHANNEL,

          `⚠️ **変更申請 #${requestId}**

元の登録情報が見つからなかったため、承認できませんでした。`,
        );
      }


      continue;
    }


    /*
     * 申請後に現在の登録情報が
     * 別の方法で変更されていないか確認。
     *
     * 申請時点と違っていたら
     * 古い申請で上書きしない。
     */
    if (
      String(
        currentMember.player_name,
      ) !==
        String(
          changeRequest.old_player_name,
        ) ||

      String(
        currentMember.player_id,
      ) !==
        String(
          changeRequest.old_player_id,
        ) ||

      String(
        currentMember.kingdom_id,
      ) !==
        String(
          changeRequest.old_kingdom_id,
        )
    ) {

      const result =
        await env.MEMBERS_DB
          .prepare(`
            UPDATE change_requests

            SET
              status = 'error',
              resolved_at =
                CURRENT_TIMESTAMP

            WHERE
              id = ?
              AND status = 'pending'
          `)

          .bind(
            requestId,
          )

          .run();


      const changed =
        Number(
          result?.meta?.changes ??
          result?.changes ??
          0,
        );


      if (
        changed > 0
      ) {

        await sendDiscordToChannel(

          env,

          CHANGE_REQUEST_CHANNEL,

          `⚠️ **変更申請 #${requestId}**

申請後に登録情報が変わっていたため、自動承認を中止しました。

現在：
${currentMember.player_name}
王国${currentMember.kingdom_id}
ID ${currentMember.player_id}`,
        );
      }


      continue;
    }


    /*
     * 変更後の
     * ID + 王国番号が
     * 別の登録と重複していないか
     * 承認直前にも再確認
     */
    const duplicate =
      await env.MEMBERS_DB
        .prepare(`
          SELECT id

          FROM members

          WHERE
            player_id = ?
            AND kingdom_id = ?
            AND id <> ?
            AND active = 1

          LIMIT 1
        `)

        .bind(
          changeRequest.new_player_id,
          changeRequest.new_kingdom_id,
          changeRequest.member_id,
        )

        .first();


    if (duplicate) {

      const result =
        await env.MEMBERS_DB
          .prepare(`
            UPDATE change_requests

            SET
              status = 'error',
              resolved_at =
                CURRENT_TIMESTAMP

            WHERE
              id = ?
              AND status = 'pending'
          `)

          .bind(
            requestId,
          )

          .run();


      const changed =
        Number(
          result?.meta?.changes ??
          result?.changes ??
          0,
        );


      if (
        changed > 0
      ) {

        await sendDiscordToChannel(

          env,

          CHANGE_REQUEST_CHANNEL,

          `⚠️ **変更申請 #${requestId}**

変更後のプレイヤーID・王国番号が、別の登録と重複しているため承認できませんでした。`,
        );
      }


      continue;
    }


    /*
     * プレイヤーIDが変わったか
     */
    const playerIdChanged =

      String(
        currentMember.player_id,
      ) !==

      String(
        changeRequest.new_player_id,
      );


    /*
     * membersの「同じ1件」をUPDATEする。
     *
     * INSERTではないため、
     * 名前・ID・王国番号を変更しても
     * 登録が2件になることはない。
     */
    try {

      await env.MEMBERS_DB
        .prepare(`
          UPDATE members

          SET
            player_name = ?,
            player_id = ?,
            kingdom_id = ?

          WHERE
            id = ?
            AND active = 1
        `)

        .bind(
          changeRequest.new_player_name,
          changeRequest.new_player_id,
          changeRequest.new_kingdom_id,
          changeRequest.member_id,
        )

        .run();

    } catch (error) {

      /*
       * UNIQUE制約などで
       * UPDATEできなかった場合
       */
      console.error(
        `change request #${requestId} member update error:`,
        error,
      );


      const result =
        await env.MEMBERS_DB
          .prepare(`
            UPDATE change_requests

            SET
              status = 'error',
              resolved_at =
                CURRENT_TIMESTAMP

            WHERE
              id = ?
              AND status = 'pending'
          `)

          .bind(
            requestId,
          )

          .run();


      const changed =
        Number(
          result?.meta?.changes ??
          result?.changes ??
          0,
        );


      if (
        changed > 0
      ) {

        await sendDiscordToChannel(

          env,

          CHANGE_REQUEST_CHANNEL,

          `⚠️ **変更申請 #${requestId}**

登録情報の更新中にエラーが発生しました。

登録情報が重複していないか確認してください。`,
        );
      }


      continue;
    }


    /*
     * =====================================================
     * IDを変更した場合だけ
     * 旧アカウントのギフト受取履歴を削除
     * =====================================================
     *
     * member_id自体は同じなので、
     * この削除をしないと
     *
     * 「旧IDで既に受け取ったコード」
     *
     * が新しいIDでも受取済み扱いになる。
     *
     * 名前変更・王国変更だけなら
     * この処理は行わない。
     */
    if (
      playerIdChanged
    ) {

      await env.MEMBERS_DB
        .prepare(`
          DELETE FROM processed_codes

          WHERE member_id = ?
        `)

        .bind(
          changeRequest.member_id,
        )

        .run();
    }


    /*
     * 申請を承認済みにする
     */
    const approvedResult =
      await env.MEMBERS_DB
        .prepare(`
          UPDATE change_requests

          SET
            status = 'approved',
            resolved_at =
              CURRENT_TIMESTAMP

          WHERE
            id = ?
            AND status = 'pending'
        `)

        .bind(
          requestId,
        )

        .run();


    const approvedChanged =
      Number(
        approvedResult
          ?.meta
          ?.changes ??

        approvedResult
          ?.changes ??

        0,
      );


    /*
     * 念のため
     */
    if (
      approvedChanged === 0
    ) {

      console.log(
        `change request #${requestId}: already processed`,
      );

      continue;
    }


    /*
     * Discordに承認結果を通知
     */
    let approvedText =

      `✅ **変更申請 #${requestId} を承認しました。**

**変更前**
名前：${changeRequest.old_player_name}
王国：${changeRequest.old_kingdom_id}
ID：${changeRequest.old_player_id}

**変更後**
名前：${changeRequest.new_player_name}
王国：${changeRequest.new_kingdom_id}
ID：${changeRequest.new_player_id}

登録件数は増えず、元の登録1件が更新されています。`;


    if (
      playerIdChanged
    ) {

      approvedText += `

🔄 プレイヤーIDが変更されたため、旧IDのギフトコード受取履歴は引き継いでいません。

現在有効なコードは、新しいIDに対して順番に自動受取されます。`;

    } else {

      approvedText += `

☑️ プレイヤーIDは同じため、これまでのギフトコード受取履歴は維持されています。`;
    }


    await sendDiscordToChannel(

      env,

      CHANGE_REQUEST_CHANNEL,

      approvedText,
    );
  }
}



/* =========================================================
   Discordの指定チャンネルへ送信
========================================================= */

async function sendDiscordToChannel(
  env,
  channelId,
  content,
) {

  if (!env.DISCORD_BOT_TOKEN) {

    throw new Error(
      "DISCORD_BOT_TOKEN が未設定です",
    );
  }


  const response =
    await fetch(

      `https://discord.com/api/v10/channels/${channelId}/messages`,

      {
        method: "POST",

        headers: {

          Authorization:
            `Bot ${env.DISCORD_BOT_TOKEN}`,

          "Content-Type":
            "application/json",
        },


        body:
          JSON.stringify({
            content,
          }),
      },
    );


  if (!response.ok) {

    const responseText =
      await response.text();


    throw new Error(

      `Discord送信エラー: HTTP ${response.status} ${responseText}`,
    );
  }


  return response.json();
}



/* =========================================================
   Discordからギフトコード取得
========================================================= */

async function checkDiscord(env) {

  if (!env.DISCORD_BOT_TOKEN) {

    throw new Error(
      "DISCORD_BOT_TOKEN が未設定です",
    );
  }


  const response =
    await fetch(

      `https://discord.com/api/v10/channels/${SOURCE_CHANNEL}/messages?limit=20`,

      {
        headers: {

          Authorization:
            `Bot ${env.DISCORD_BOT_TOKEN}`,

          "User-Agent":
            "WOSGiftAuto (Cloudflare Workers, 3.0)",
        },
      },
    );


  if (!response.ok) {

    throw new Error(
      `Discord読取エラー: HTTP ${response.status}`,
    );
  }


  const messages =
    await response.json();


  /*
   * 常設コードは
   * Discordの表示位置に関係なく
   * 常に処理対象へ含める。
   */
  const codes =
    new Set(
      PERMANENT_CODES,
    );


  /*
   * 古いメッセージ
   * ↓
   * 新しいメッセージ
   */
  for (
    const message of
      [...messages].reverse()
  ) {

    const text = [

      message.content || "",


      ...(message.embeds || [])
        .flatMap(

          (embed) => [

            embed.title || "",

            embed.description || "",


            ...(embed.fields || [])
              .map(

                (field) =>
                  `${field.name} ${field.value}`,

              ),
          ],
        ),

    ].join("\n");


    /*
     * 例：
     *
     * Gift Code: ABC123
     * Code: ABC123
     * code：ABC123
     */
    for (
      const match of
        text.matchAll(

          /(?:gift\s*code|code)\s*[:：]\s*([A-Za-z0-9_-]{4,64})/gi,

        )
    ) {

      codes.add(
        match[1],
      );
    }
  }


  /*
   * 見つけたコードを
   * code_jobsへ保存
   */
  for (
    const code of codes
  ) {

    await env.MEMBERS_DB
      .prepare(`
        INSERT OR IGNORE
        INTO code_jobs
        (
          code,
          notified
        )

        VALUES
        (
          ?,

          CASE

            WHEN EXISTS
            (
              SELECT 1

              FROM processed_codes

              WHERE code = ?
            )

            AND NOT EXISTS
            (
              SELECT 1

              FROM members m

              LEFT JOIN
                processed_codes p

                ON
                  p.member_id = m.id
                  AND p.code = ?

              WHERE
                m.active = 1
                AND p.member_id IS NULL
            )

            THEN 1

            ELSE 0

          END
        )
      `)

      .bind(
        code,
        code,
        code,
      )

      .run();
  }


  /*
   * 今Discord上で確認できるコード +
   * 常設コードだけを処理する。
   */
  const activeCodes = [
    ...codes,
  ];


  /*
   * PERMANENT_CODESがあるため
   * 通常ここが0になることはないが
   * 念のため。
   */
  if (
    activeCodes.length === 0
  ) {

    return;
  }


  const placeholders =
    activeCodes
      .map(
        () => "?",
      )
      .join(", ");


  /*
   * 処理するコードを取得
   */
  const {
    results: jobs = [],
  } =

    await env.MEMBERS_DB
      .prepare(`
        SELECT
          j.code

        FROM code_jobs j

        WHERE
          j.code IN (${placeholders})

          AND
          (
            j.notified = 0

            OR EXISTS
            (
              SELECT 1

              FROM members m

              LEFT JOIN
                processed_codes p

                ON
                  p.member_id = m.id
                  AND p.code = j.code

              WHERE
                m.active = 1
                AND p.member_id IS NULL
            )
          )

        ORDER BY
          j.created_at ASC

        LIMIT 10
      `)

      .bind(
        ...activeCodes,
      )

      .all();


  /*
   * 各コードを登録者へ配布
   */
  for (
    const job of jobs
  ) {

    try {

      await processCodeForMembers(
        job.code,
        env,
      );

    } catch (error) {

      console.error(
        `code ${job.code} error:`,
        error,
      );
    }
  }
}



/* =========================================================
   コードを登録者へ配布
========================================================= */

async function processCodeForMembers(
  code,
  env,
) {

  const now =
    Math.floor(
      Date.now() / 1000,
    );


  /*
   * 3分間ロック
   */
  const lockUntil =
    now + 180;


  /*
   * このコードの処理権を取得
   */
  const lockResult =

    await env.MEMBERS_DB
      .prepare(`
        UPDATE code_jobs

        SET
          locked_until = ?

        WHERE
          code = ?

          AND locked_until < ?

          AND
          (
            notified = 0

            OR EXISTS
            (
              SELECT 1

              FROM members m

              LEFT JOIN
                processed_codes p

                ON
                  p.member_id = m.id
                  AND p.code =
                    code_jobs.code

              WHERE
                m.active = 1
                AND p.member_id IS NULL
            )
          )
      `)

      .bind(
        lockUntil,
        code,
        now,
      )

      .run();


  const changed =
    Number(

      lockResult
        ?.meta
        ?.changes ??

      lockResult
        ?.changes ??

      0,
    );


  /*
   * 他のCronが処理中
   */
  if (
    changed === 0
  ) {

    console.log(
      `code ${code}: locked or already notified`,
    );

    return;
  }


  try {

    /*
     * このコードがまだ未処理の人を
     * 最大10人取得
     */
    const {
      results: members = [],
    } =

      await env.MEMBERS_DB
        .prepare(`
          SELECT
            m.id,
            m.player_name,
            m.player_id,
            m.kingdom_id

          FROM members m

          LEFT JOIN
            processed_codes p

            ON
              p.member_id = m.id
              AND p.code = ?

          WHERE
            m.active = 1
            AND p.member_id IS NULL

          ORDER BY
            m.id

          LIMIT ?
        `)

        .bind(
          code,
          MAX_MEMBERS_PER_RUN,
        )

        .all();


    /*
     * 最終結果としてDBに保存する
     * ホワサバAPIの結果コード
     */
    const finalCodes =
      new Set([

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


    /*
     * 各登録者を処理
     */
    for (
      const member of members
    ) {

      try {

        const result =
          await redeem(

            code,

            member.player_id,

            member.kingdom_id,
          );


        console.log(

          "redeem result:",

          {
            code,

            player:
              member.player_id,

            errCode:
              result.errCode,

            message:
              result.message,
          },
        );


        /*
         * 一時的・未知の結果は
         * DBに保存しない。
         *
         * 次回Cronで再試行する。
         */
        if (
          !finalCodes.has(
            result.errCode,
          )
        ) {

          console.log(

            `retry later: code=${code} player=${member.player_id} err=${result.errCode}`,

          );

          continue;
        }


        /*
         * 最終結果を保存
         */
        await env.MEMBERS_DB
          .prepare(`
            INSERT OR REPLACE
            INTO processed_codes
            (
              code,
              member_id,
              err_code,
              message
            )

            VALUES (
              ?,
              ?,
              ?,
              ?
            )
          `)

          .bind(
            code,
            member.id,
            result.errCode,
            result.message,
          )

          .run();

      } catch (error) {

        /*
         * 1人失敗しても
         * 残りの人は続行。
         *
         * DBに保存されないため
         * 次回Cronで再試行される。
         */
        console.error(

          `redeem error: code=${code} name=${member.player_name} player=${member.player_id}`,

          error,
        );
      }
    }


    /*
     * このコードが
     * まだ未処理の登録者数
     */
    const remainingRow =

      await env.MEMBERS_DB
        .prepare(`
          SELECT
            COUNT(*) AS total

          FROM members m

          LEFT JOIN
            processed_codes p

            ON
              p.member_id = m.id
              AND p.code = ?

          WHERE
            m.active = 1
            AND p.member_id IS NULL
        `)

        .bind(
          code,
        )

        .first();


    const remaining =
      Number(
        remainingRow?.total || 0,
      );


    console.log(
      `code ${code}: remaining=${remaining}`,
    );


    /*
     * まだ未処理の人がいる。
     *
     * 次の毎分Cronへ回す。
     */
    if (
      remaining > 0
    ) {

      return;
    }


    /*
     * 全員完了したので
     * 結果を集計
     */
    const totals =

      await env.MEMBERS_DB
        .prepare(`
          SELECT

            SUM(
              CASE
                WHEN
                  p.err_code = '20000'
                THEN 1
                ELSE 0
              END
            ) AS success,


            SUM(
              CASE
                WHEN
                  p.err_code IN
                  (
                    '40008',
                    '40011'
                  )
                THEN 1
                ELSE 0
              END
            ) AS already,


            SUM(
              CASE
                WHEN
                  p.err_code NOT IN
                  (
                    '20000',
                    '40008',
                    '40011'
                  )
                THEN 1
                ELSE 0
              END
            ) AS failed


          FROM members m

          JOIN processed_codes p

            ON
              p.member_id = m.id
              AND p.code = ?

          WHERE
            m.active = 1
        `)

        .bind(
          code,
        )

        .first();


    const success =
      Number(
        totals?.success || 0,
      );


    const already =
      Number(
        totals?.already || 0,
      );


    const failed =
      Number(
        totals?.failed || 0,
      );


    /*
     * 既に結果通知済みか確認
     */
    const job =

      await env.MEMBERS_DB
        .prepare(`
          SELECT
            notified

          FROM code_jobs

          WHERE
            code = ?
        `)

        .bind(
          code,
        )

        .first();


    if (
      Number(
        job?.notified || 0,
      ) === 1
    ) {

      return;
    }


    /*
     * 全員完了後に1回だけ
     * Discordへ結果通知
     */
    await sendDiscord(

      env,

      `🎁 **ギフトコード自動交換結果**
コード：\`${code}\`
✅ 受取成功：${success}人
☑️ 受取済み：${already}人
⚠️ その他：${failed}人
🏁 全登録者の処理完了`,
    );


    /*
     * Discord送信成功後だけ
     * notified = 1
     */
    await env.MEMBERS_DB
      .prepare(`
        UPDATE code_jobs

        SET
          notified = 1

        WHERE
          code = ?
      `)

      .bind(
        code,
      )

      .run();


    console.log(

      `code ${code}: completed and notified`,

    );

  } finally {

    /*
     * 成功・失敗に関係なく
     * コードのロック解除
     */
    await env.MEMBERS_DB
      .prepare(`
        UPDATE code_jobs

        SET
          locked_until = 0

        WHERE
          code = ?
      `)

      .bind(
        code,
      )

      .run();
  }
}

/* =========================================================
   ホワサバAPI
========================================================= */

async function redeem(
  code,
  playerId,
  kingdomId,
) {

  const time =
    Math.floor(
      Date.now() / 1000,
    ).toString();


  const sign =
    md5(
      `cdk=${code}&fid=${playerId}&kid=${kingdomId}&time=${time}${WOS_KEY}`,
    );


  const body =
    new URLSearchParams({

      cdk:
        code,

      fid:
        playerId,

      kid:
        kingdomId,

      time,

      sign,
    });


  /*
   * APIタイムアウト
   */
  const controller =
    new AbortController();


  const timer =
    setTimeout(

      () =>
        controller.abort(),

      REDEEM_TIMEOUT_MS,
    );


  let response;


  try {

    response =
      await fetch(

        WOS_API,

        {
          method:
            "POST",


          headers: {

            "Content-Type":
              "application/x-www-form-urlencoded",

            Accept:
              "application/json, text/plain, */*",

            Origin:
              "https://wos-giftcode.centurygame.com",

            Referer:
              "https://wos-giftcode.centurygame.com/",

            "User-Agent":
              "Mozilla/5.0 AppleWebKit/537.36 Chrome/134 Safari/537.36",
          },


          body:
            body.toString(),


          signal:
            controller.signal,
        },
      );

  } finally {

    clearTimeout(
      timer,
    );
  }


  if (!response.ok) {

    throw new Error(

      `ホワサバAPIエラー: HTTP ${response.status}`,

    );
  }


  let data;


  try {

    data =
      await response.json();

  } catch (_error) {

    throw new Error(
      "ホワサバAPIからJSON以外の応答が返りました",
    );
  }


  return {

    errCode:
      String(
        data.err_code ?? "",
      ),

    message:
      String(
        data.msg ?? "",
      ),
  };
}



/* =========================================================
   ギフトコード結果をDiscordへ送信
========================================================= */

async function sendDiscord(
  env,
  content,
) {

  /*
   * 共通のDiscord送信関数を使用。
   *
   * ギフトコード結果は
   * RESULT_CHANNELへ送る。
   */
  return sendDiscordToChannel(

    env,

    RESULT_CHANNEL,

    content,
  );
}



/* =========================================================
   メッセージページ
========================================================= */

function pageMessage(
  title,
  message,
  ok,
) {

  return new Response(

    `<!doctype html>

<html lang="ja">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
${escapeHtml(title)}
</title>

<style>
${PAGE_STYLE}
</style>

</head>


<body>

<main>

<div class="mark">
${ok ? "✓" : "!"}
</div>


<h1>
${escapeHtml(title)}
</h1>


<p>
${message}
</p>


<div class="page-links">

<a href="/">
新規登録
</a>

<a href="/manage">
登録情報を確認・変更
</a>

</div>

</main>

</body>

</html>`,

    {
      status:
        ok ? 200 : 400,

      headers: {

        "Content-Type":
          "text/html; charset=UTF-8",
      },
    },
  );
}



/* =========================================================
   HTML escape
========================================================= */

function escapeHtml(
  value,
) {

  return String(value)
    .replace(

      /[&<>"']/g,

      (char) =>
        ({

          "&":
            "&amp;",

          "<":
            "&lt;",

          ">":
            "&gt;",

          '"':
            "&quot;",

          "'":
            "&#39;",

        })[char],
    );
}



/* =========================================================
   登録情報編集ページ
========================================================= */

function editMemberPage(
  member,
) {

  return `
<!doctype html>

<html lang="ja">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
登録情報を変更
</title>

<style>
${PAGE_STYLE}
</style>

</head>


<body>

<main>

<div class="logo">
✏️
</div>


<h1>
登録情報を変更
</h1>


<p>
現在の登録情報です。
変更したい項目を書き換えて、
変更申請を送ってください。
</p>


<div class="info-box">

<div class="info-label">
現在の登録
</div>

<div class="info-row">
<span>
名前
</span>

<strong>
${escapeHtml(
  member.player_name,
)}
</strong>
</div>


<div class="info-row">
<span>
プレイヤーID
</span>

<strong>
${escapeHtml(
  member.player_id,
)}
</strong>
</div>


<div class="info-row">
<span>
王国
</span>

<strong>
${escapeHtml(
  member.kingdom_id,
)}
</strong>
</div>

</div>


<form
  method="POST"
  action="/change-request"
>


<input
  type="hidden"
  name="member_id"
  value="${Number(
    member.id,
  )}"
>


<input
  type="hidden"
  name="old_player_id"
  value="${escapeHtml(
    member.player_id,
  )}"
>


<input
  type="hidden"
  name="old_kingdom_id"
  value="${escapeHtml(
    member.kingdom_id,
  )}"
>


<label>
プレイヤー名
</label>

<input
  type="text"
  name="player_name"
  maxlength="30"
  value="${escapeHtml(
    member.player_name,
  )}"
  required
>


<label>
プレイヤーID
</label>

<input
  type="text"
  name="player_id"
  inputmode="numeric"
  pattern="[0-9]*"
  value="${escapeHtml(
    member.player_id,
  )}"
  required
>


<label>
王国番号
</label>

<input
  type="text"
  name="kingdom_id"
  inputmode="numeric"
  pattern="[0-9]*"
  value="${escapeHtml(
    member.kingdom_id,
  )}"
  required
>


<button type="submit">
変更を申請する
</button>


<small>
申請しただけでは登録情報は変更されません。
管理者がDiscordで承認すると反映されます。
</small>


<small>
名前・王国番号・プレイヤーIDを変更しても、
古い登録が別に残ることはありません。
現在の登録1件が更新されます。
</small>


<small>
プレイヤーIDを変更した場合のみ、
旧プレイヤーIDのギフトコード受取履歴は
新しいIDへ引き継がれません。
</small>


</form>


<div class="page-links">

<a href="/manage">
確認画面へ戻る
</a>

<a href="/">
新規登録
</a>

</div>

</main>

</body>

</html>
`;
}



/* =========================================================
   登録情報確認ページ
========================================================= */

const MANAGE_PAGE = `
<!doctype html>

<html lang="ja">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
登録情報の確認・変更
</title>

<style>
${PAGE_STYLE}
</style>

</head>


<body>

<main>

<div class="logo">
🔎
</div>


<h1>
登録情報の確認・変更
</h1>


<p>
現在登録されている
プレイヤーIDと王国番号を入力してください。
</p>


<p>
登録が見つかると、
現在の名前・ID・王国番号を確認して
変更申請を送ることができます。
</p>


<form
  method="POST"
  action="/lookup-member"
>


<label>
現在のプレイヤーID
</label>

<input
  type="text"
  name="player_id"
  inputmode="numeric"
  pattern="[0-9]*"
  placeholder="例：441788306"
  required
>


<label>
現在の王国番号
</label>

<input
  type="text"
  name="kingdom_id"
  inputmode="numeric"
  pattern="[0-9]*"
  placeholder="例：3338"
  required
>


<button type="submit">
登録情報を確認する
</button>


<small>
移民した場合は、
まず移民前の王国番号で現在の登録を検索し、
その後、新しい王国番号へ変更申請してください。
</small>


</form>


<div class="page-links">

<a href="/">
新規登録へ戻る
</a>

</div>

</main>

</body>

</html>
`;



/* =========================================================
   ページ共通CSS
========================================================= */

const PAGE_STYLE = `
* {
  box-sizing:
    border-box;
}


body {

  margin:
    0;


  background:
    #071426;


  color:
    #f7fbff;


  font-family:
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;


  min-height:
    100vh;


  display:
    grid;


  place-items:
    center;


  padding:
    22px;
}


main {

  width:
    min(
      100%,
      440px
    );


  background:
    linear-gradient(
      145deg,
      #102746,
      #0b1c33
    );


  border:
    1px solid #27466e;


  border-radius:
    26px;


  padding:
    30px;


  box-shadow:
    0 24px 70px #0008;
}


h1 {

  margin:
    8px 0 12px;


  font-size:
    28px;
}


p {

  color:
    #b9c9dc;


  line-height:
    1.7;
}


.logo,
.mark {

  width:
    58px;


  height:
    58px;


  display:
    grid;


  place-items:
    center;


  border-radius:
    18px;


  background:
    #ffb229;


  color:
    #111;


  font-size:
    30px;


  font-weight:
    800;
}


label {

  display:
    block;


  margin:
    18px 0 7px;


  color:
    #d9e6f4;


  font-weight:
    700;
}


input {

  width:
    100%;


  border:
    1px solid #36567d;


  background:
    #07172b;


  color:
    white;


  border-radius:
    13px;


  padding:
    15px;


  font-size:
    17px;


  outline:
    none;
}


input:focus {

  border-color:
    #ffb229;


  box-shadow:
    0 0 0 3px #ffb22922;
}


button {

  width:
    100%;


  margin-top:
    24px;


  border:
    0;


  border-radius:
    14px;


  padding:
    16px;


  background:
    #ffb229;


  color:
    #111;


  font-size:
    17px;


  font-weight:
    800;


  cursor:
    pointer;
}


button:active {

  transform:
    scale(
      0.98
    );
}


a {

  display:
    inline-block;


  color:
    #ffbd48;


  text-decoration:
    none;


  font-weight:
    700;
}


small {

  display:
    block;


  margin-top:
    12px;


  color:
    #7890aa;


  line-height:
    1.6;
}


.page-links {

  display:
    flex;


  flex-wrap:
    wrap;


  gap:
    18px;


  margin-top:
    22px;
}


.info-box {

  margin:
    22px 0;


  padding:
    18px;


  background:
    #07172b;


  border:
    1px solid #36567d;


  border-radius:
    16px;
}


.info-label {

  margin-bottom:
    12px;


  color:
    #ffbd48;


  font-size:
    14px;


  font-weight:
    800;
}


.info-row {

  display:
    flex;


  justify-content:
    space-between;


  gap:
    15px;


  padding:
    8px 0;


  border-bottom:
    1px solid #ffffff10;
}


.info-row:last-child {

  border-bottom:
    0;
}


.info-row span {

  color:
    #7890aa;
}


.info-row strong {

  text-align:
    right;


  overflow-wrap:
    anywhere;
}
`;



/* =========================================================
   新規登録ページ
========================================================= */

const REGISTRATION_PAGE = `
<!doctype html>

<html lang="ja">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
ホワサバ ギフトコード自動受取
</title>

<style>
${PAGE_STYLE}
</style>

</head>


<body>

<main>

<div class="logo">
🎁
</div>


<h1>
ギフトコード自動受取
</h1>


<p>
プレイヤー情報を登録すると、
新しいギフトコードを検知した際に
自動で受取処理を行います。
</p>


<form
  method="POST"
  action="/register"
>


<label>
プレイヤー名
</label>

<input
  type="text"
  name="player_name"
  maxlength="30"
  placeholder="ゲーム内の名前"
  required
>


<label>
プレイヤーID
</label>

<input
  type="text"
  name="player_id"
  inputmode="numeric"
  pattern="[0-9]*"
  placeholder="例：441788306"
  required
>


<label>
王国番号
</label>

<input
  type="text"
  name="kingdom_id"
  inputmode="numeric"
  pattern="[0-9]*"
  placeholder="例：3338"
  required
>


<button type="submit">
登録する
</button>


<small>
登録済みのプレイヤーは、
同じプレイヤーID・王国番号で
重複登録されません。
</small>


</form>


<div class="page-links">

<a href="/manage">
登録情報を確認・変更する
</a>

</div>

</main>

</body>

</html>
`;



/* =========================================================
   MD5
========================================================= */

/*
 * 外部ライブラリなしで動くMD5
 */
function md5(
  string,
) {

  function rotateLeft(
    value,
    shift,
  ) {

    return (

      (value << shift) |

      (
        value >>>
        (32 - shift)
      )
    );
  }


  function addUnsigned(
    x,
    y,
  ) {

    const x4 =
      x & 0x40000000;


    const y4 =
      y & 0x40000000;


    const x8 =
      x & 0x80000000;


    const y8 =
      y & 0x80000000;


    const result =

      (
        x &
        0x3fffffff
      )

      +

      (
        y &
        0x3fffffff
      );


    if (
      x4 &
      y4
    ) {

      return (

        result ^

        0x80000000 ^

        x8 ^

        y8
      );
    }


    if (
      x4 |
      y4
    ) {

      if (
        result &
        0x40000000
      ) {

        return (

          result ^

          0xc0000000 ^

          x8 ^

          y8
        );
      }


      return (

        result ^

        0x40000000 ^

        x8 ^

        y8
      );
    }


    return (

      result ^

      x8 ^

      y8
    );
  }


  function F(
    x,
    y,
    z,
  ) {

    return (

      (x & y) |

      (~x & z)
    );
  }


  function G(
    x,
    y,
    z,
  ) {

    return (

      (x & z) |

      (y & ~z)
    );
  }


  function H(
    x,
    y,
    z,
  ) {

    return (
      x ^
      y ^
      z
    );
  }


  function I(
    x,
    y,
    z,
  ) {

    return (

      y ^

      (
        x |
        ~z
      )
    );
  }


  function FF(
    a,
    b,
    c,
    d,
    x,
    s,
    ac,
  ) {

    a =
      addUnsigned(

        a,

        addUnsigned(

          addUnsigned(

            F(
              b,
              c,
              d,
            ),

            x,
          ),

          ac,
        ),
      );


    return addUnsigned(

      rotateLeft(
        a,
        s,
      ),

      b,
    );
  }


  function GG(
    a,
    b,
    c,
    d,
    x,
    s,
    ac,
  ) {

    a =
      addUnsigned(

        a,

        addUnsigned(

          addUnsigned(

            G(
              b,
              c,
              d,
            ),

            x,
          ),

          ac,
        ),
      );


    return addUnsigned(

      rotateLeft(
        a,
        s,
      ),

      b,
    );
  }


  function HH(
    a,
    b,
    c,
    d,
    x,
    s,
    ac,
  ) {

    a =
      addUnsigned(

        a,

        addUnsigned(

          addUnsigned(

            H(
              b,
              c,
              d,
            ),

            x,
          ),

          ac,
        ),
      );


    return addUnsigned(

      rotateLeft(
        a,
        s,
      ),

      b,
    );
  }


  function II(
    a,
    b,
    c,
    d,
    x,
    s,
    ac,
  ) {

    a =
      addUnsigned(

        a,

        addUnsigned(

          addUnsigned(

            I(
              b,
              c,
              d,
            ),

            x,
          ),

          ac,
        ),
      );


    return addUnsigned(

      rotateLeft(
        a,
        s,
      ),

      b,
    );
  }

  function convertToWordArray(
    string,
  ) {

    const messageLength =
      string.length;


    const numberOfWordsTemp1 =
      messageLength + 8;


    const numberOfWordsTemp2 =
      (
        numberOfWordsTemp1 -
        (
          numberOfWordsTemp1 %
          64
        )
      ) / 64;


    const numberOfWords =
      (
        numberOfWordsTemp2 + 1
      ) * 16;


    const wordArray =
      new Array(
        numberOfWords - 1,
      );


    let bytePosition = 0;

    let byteCount = 0;


    while (
      byteCount <
      messageLength
    ) {

      const wordCount =
        (
          byteCount -
          (
            byteCount % 4
          )
        ) / 4;


      bytePosition =
        (
          byteCount % 4
        ) * 8;


      wordArray[
        wordCount
      ] =
        (
          wordArray[
            wordCount
          ] || 0
        ) |

        (
          string.charCodeAt(
            byteCount,
          ) <<
          bytePosition
        );


      byteCount++;
    }


    const wordCount =
      (
        byteCount -
        (
          byteCount % 4
        )
      ) / 4;


    bytePosition =
      (
        byteCount % 4
      ) * 8;


    wordArray[
      wordCount
    ] =
      (
        wordArray[
          wordCount
        ] || 0
      ) |

      (
        0x80 <<
        bytePosition
      );


    wordArray[
      numberOfWords - 2
    ] =
      messageLength << 3;


    wordArray[
      numberOfWords - 1
    ] =
      messageLength >>> 29;


    return wordArray;
  }


  function wordToHex(
    value,
  ) {

    let result = "";


    for (
      let count = 0;
      count <= 3;
      count++
    ) {

      const byte =
        (
          value >>>
          (
            count * 8
          )
        ) &
        255;


      const temp =
        `0${byte.toString(16)}`;


      result +=
        temp.slice(-2);
    }


    return result;
  }


  function utf8Encode(
    value,
  ) {

    value =
      value.replace(
        /\r\n/g,
        "\n",
      );


    let utfText = "";


    for (
      let n = 0;
      n < value.length;
      n++
    ) {

      const c =
        value.charCodeAt(
          n,
        );


      if (
        c < 128
      ) {

        utfText +=
          String.fromCharCode(
            c,
          );

      } else if (
        c < 2048
      ) {

        utfText +=
          String.fromCharCode(
            (c >> 6) |
            192,
          );


        utfText +=
          String.fromCharCode(
            (c & 63) |
            128,
          );

      } else {

        utfText +=
          String.fromCharCode(
            (c >> 12) |
            224,
          );


        utfText +=
          String.fromCharCode(
            (
              (c >> 6) &
              63
            ) |
            128,
          );


        utfText +=
          String.fromCharCode(
            (c & 63) |
            128,
          );
      }
    }


    return utfText;
  }


  string =
    utf8Encode(
      string,
    );


  const x =
    convertToWordArray(
      string,
    );


  let a =
    0x67452301;


  let b =
    0xefcdab89;


  let c =
    0x98badcfe;


  let d =
    0x10325476;


  const S11 = 7;
  const S12 = 12;
  const S13 = 17;
  const S14 = 22;

  const S21 = 5;
  const S22 = 9;
  const S23 = 14;
  const S24 = 20;

  const S31 = 4;
  const S32 = 11;
  const S33 = 16;
  const S34 = 23;

  const S41 = 6;
  const S42 = 10;
  const S43 = 15;
  const S44 = 21;


  for (
    let k = 0;
    k < x.length;
    k += 16
  ) {

    const AA = a;
    const BB = b;
    const CC = c;
    const DD = d;


    /*
     * Round 1
     */

    a = FF(
      a, b, c, d,
      x[k + 0],
      S11,
      0xd76aa478,
    );

    d = FF(
      d, a, b, c,
      x[k + 1],
      S12,
      0xe8c7b756,
    );

    c = FF(
      c, d, a, b,
      x[k + 2],
      S13,
      0x242070db,
    );

    b = FF(
      b, c, d, a,
      x[k + 3],
      S14,
      0xc1bdceee,
    );

    a = FF(
      a, b, c, d,
      x[k + 4],
      S11,
      0xf57c0faf,
    );

    d = FF(
      d, a, b, c,
      x[k + 5],
      S12,
      0x4787c62a,
    );

    c = FF(
      c, d, a, b,
      x[k + 6],
      S13,
      0xa8304613,
    );

    b = FF(
      b, c, d, a,
      x[k + 7],
      S14,
      0xfd469501,
    );

    a = FF(
      a, b, c, d,
      x[k + 8],
      S11,
      0x698098d8,
    );

    d = FF(
      d, a, b, c,
      x[k + 9],
      S12,
      0x8b44f7af,
    );

    c = FF(
      c, d, a, b,
      x[k + 10],
      S13,
      0xffff5bb1,
    );

    b = FF(
      b, c, d, a,
      x[k + 11],
      S14,
      0x895cd7be,
    );

    a = FF(
      a, b, c, d,
      x[k + 12],
      S11,
      0x6b901122,
    );

    d = FF(
      d, a, b, c,
      x[k + 13],
      S12,
      0xfd987193,
    );

    c = FF(
      c, d, a, b,
      x[k + 14],
      S13,
      0xa679438e,
    );

    b = FF(
      b, c, d, a,
      x[k + 15],
      S14,
      0x49b40821,
    );


    /*
     * Round 2
     */

    a = GG(
      a, b, c, d,
      x[k + 1],
      S21,
      0xf61e2562,
    );

    d = GG(
      d, a, b, c,
      x[k + 6],
      S22,
      0xc040b340,
    );

    c = GG(
      c, d, a, b,
      x[k + 11],
      S23,
      0x265e5a51,
    );

    b = GG(
      b, c, d, a,
      x[k + 0],
      S24,
      0xe9b6c7aa,
    );

    a = GG(
      a, b, c, d,
      x[k + 5],
      S21,
      0xd62f105d,
    );

    d = GG(
      d, a, b, c,
      x[k + 10],
      S22,
      0x02441453,
    );

    c = GG(
      c, d, a, b,
      x[k + 15],
      S23,
      0xd8a1e681,
    );

    b = GG(
      b, c, d, a,
      x[k + 4],
      S24,
      0xe7d3fbc8,
    );

    a = GG(
      a, b, c, d,
      x[k + 9],
      S21,
      0x21e1cde6,
    );

    d = GG(
      d, a, b, c,
      x[k + 14],
      S22,
      0xc33707d6,
    );

    c = GG(
      c, d, a, b,
      x[k + 3],
      S23,
      0xf4d50d87,
    );

    b = GG(
      b, c, d, a,
      x[k + 8],
      S24,
      0x455a14ed,
    );

    a = GG(
      a, b, c, d,
      x[k + 13],
      S21,
      0xa9e3e905,
    );

    d = GG(
      d, a, b, c,
      x[k + 2],
      S22,
      0xfcefa3f8,
    );

    c = GG(
      c, d, a, b,
      x[k + 7],
      S23,
      0x676f02d9,
    );

    b = GG(
      b, c, d, a,
      x[k + 12],
      S24,
      0x8d2a4c8a,
    );


    /*
     * Round 3
     */

    a = HH(
      a, b, c, d,
      x[k + 5],
      S31,
      0xfffa3942,
    );

    d = HH(
      d, a, b, c,
      x[k + 8],
      S32,
      0x8771f681,
    );

    c = HH(
      c, d, a, b,
      x[k + 11],
      S33,
      0x6d9d6122,
    );

    b = HH(
      b, c, d, a,
      x[k + 14],
      S34,
      0xfde5380c,
    );

    a = HH(
      a, b, c, d,
      x[k + 1],
      S31,
      0xa4beea44,
    );

    d = HH(
      d, a, b, c,
      x[k + 4],
      S32,
      0x4bdecfa9,
    );

    c = HH(
      c, d, a, b,
      x[k + 7],
      S33,
      0xf6bb4b60,
    );

    b = HH(
      b, c, d, a,
      x[k + 10],
      S34,
      0xbebfbc70,
    );

    a = HH(
      a, b, c, d,
      x[k + 13],
      S31,
      0x289b7ec6,
    );

    d = HH(
      d, a, b, c,
      x[k + 0],
      S32,
      0xeaa127fa,
    );

    c = HH(
      c, d, a, b,
      x[k + 3],
      S33,
      0xd4ef3085,
    );

    b = HH(
      b, c, d, a,
      x[k + 6],
      S34,
      0x04881d05,
    );

    a = HH(
      a, b, c, d,
      x[k + 9],
      S31,
      0xd9d4d039,
    );

    d = HH(
      d, a, b, c,
      x[k + 12],
      S32,
      0xe6db99e5,
    );

    c = HH(
      c, d, a, b,
      x[k + 15],
      S33,
      0x1fa27cf8,
    );

    b = HH(
      b, c, d, a,
      x[k + 2],
      S34,
      0xc4ac5665,
    );


    /*
     * Round 4
     */

    a = II(
      a, b, c, d,
      x[k + 0],
      S41,
      0xf4292244,
    );

    d = II(
      d, a, b, c,
      x[k + 7],
      S42,
      0x432aff97,
    );

    c = II(
      c, d, a, b,
      x[k + 14],
      S43,
      0xab9423a7,
    );

    b = II(
      b, c, d, a,
      x[k + 5],
      S44,
      0xfc93a039,
    );

    a = II(
      a, b, c, d,
      x[k + 12],
      S41,
      0x655b59c3,
    );

    d = II(
      d, a, b, c,
      x[k + 3],
      S42,
      0x8f0ccc92,
    );

    c = II(
      c, d, a, b,
      x[k + 10],
      S43,
      0xffeff47d,
    );

    b = II(
      b, c, d, a,
      x[k + 1],
      S44,
      0x85845dd1,
    );

    a = II(
      a, b, c, d,
      x[k + 8],
      S41,
      0x6fa87e4f,
    );

    d = II(
      d, a, b, c,
      x[k + 15],
      S42,
      0xfe2ce6e0,
    );

    c = II(
      c, d, a, b,
      x[k + 6],
      S43,
      0xa3014314,
    );

    b = II(
      b, c, d, a,
      x[k + 13],
      S44,
      0x4e0811a1,
    );

    a = II(
      a, b, c, d,
      x[k + 4],
      S41,
      0xf7537e82,
    );

    d = II(
      d, a, b, c,
      x[k + 11],
      S42,
      0xbd3af235,
    );

    c = II(
      c, d, a, b,
      x[k + 2],
      S43,
      0x2ad7d2bb,
    );

    b = II(
      b, c, d, a,
      x[k + 9],
      S44,
      0xeb86d391,
    );


    a =
      addUnsigned(
        a,
        AA,
      );


    b =
      addUnsigned(
        b,
        BB,
      );


    c =
      addUnsigned(
        c,
        CC,
      );


    d =
      addUnsigned(
        d,
        DD,
      );
  }


  return (

    wordToHex(a) +
    wordToHex(b) +
    wordToHex(c) +
    wordToHex(d)

  ).toLowerCase();
}
