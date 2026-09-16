async function processCodeForMembers(code, env) {
  /*
   * =====================================================
   * ① コード管理テーブルを用意
   * =====================================================
   *
   * notified
   *   0 = 最終結果をまだDiscordへ送っていない
   *   1 = 送信済み
   *
   * locked_until
   *   同じコードを複数Cronが同時処理しないためのロック
   */

  await env.MEMBERS_DB.prepare(`
    CREATE TABLE IF NOT EXISTS code_jobs (
      code TEXT PRIMARY KEY,
      notified INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();


  /*
   * =====================================================
   * ② このコードが既に処理されたことがあるか確認
   * =====================================================
   */

  const existingJob =
    await env.MEMBERS_DB.prepare(`
      SELECT
        code,
        notified,
        locked_until
      FROM code_jobs
      WHERE code = ?
    `)
      .bind(code)
      .first();


  /*
   * code_jobsにまだ無い場合
   */
  if (!existingJob) {

    const oldProcessed =
      await env.MEMBERS_DB.prepare(`
        SELECT COUNT(*) AS total
        FROM processed_codes
        WHERE code = ?
      `)
        .bind(code)
        .first();


    /*
     * 既にprocessed_codesに記録がある古いコードなら、
     * 過去コードを突然Discordへ再通知しないよう
     * notified=1で登録する。
     *
     * 完全な新規コードならnotified=0。
     */
    const alreadyExists =
      Number(oldProcessed?.total || 0) > 0;


    await env.MEMBERS_DB.prepare(`
      INSERT OR IGNORE INTO code_jobs
      (
        code,
        notified,
        locked_until
      )
      VALUES (?, ?, 0)
    `)
      .bind(
        code,
        alreadyExists ? 1 : 0,
      )
      .run();


    /*
     * 過去コードならここで終了。
     */
    if (alreadyExists) {
      return;
    }
  }


  /*
   * =====================================================
   * ③ ロック取得
   * =====================================================
   */

  const now =
    Math.floor(Date.now() / 1000);

  /*
   * 最大3分間ロック。
   *
   * Workerが途中で異常終了しても
   * 3分後には自動的に再開できる。
   */
  const lockUntil =
    now + 180;


  const lockResult =
    await env.MEMBERS_DB.prepare(`
      UPDATE code_jobs

      SET locked_until = ?

      WHERE
        code = ?
        AND locked_until < ?
    `)
      .bind(
        lockUntil,
        code,
        now,
      )
      .run();


  /*
   * 他のCronが処理中。
   */
  if (
    Number(
      lockResult?.meta?.changes || 0,
    ) === 0
  ) {

    console.log(
      `skip locked code: ${code}`,
    );

    return;
  }


  try {

    /*
     * =====================================================
     * ④ 未処理メンバーを最大10人取得
     * =====================================================
     */

    const { results: members = [] } =
      await env.MEMBERS_DB.prepare(`
        SELECT
          m.id,
          m.player_name,
          m.player_id,
          m.kingdom_id

        FROM members m

        LEFT JOIN processed_codes p
          ON p.member_id = m.id
          AND p.code = ?

        WHERE
          m.active = 1
          AND p.member_id IS NULL

        ORDER BY m.id

        LIMIT 10
      `)
        .bind(code)
        .all();


    console.log(
      `code=${code} batch=${members.length}`,
    );


    /*
     * =====================================================
     * ⑤ 最終結果として保存するAPIコード
     * =====================================================
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
     * =====================================================
     * ⑥ 最大10人を処理
     * =====================================================
     */

    for (const member of members) {

      let result;


      try {

        result =
          await redeem(
            code,
            member.player_id,
            member.kingdom_id,
          );

      } catch (error) {

        /*
         * 通信エラーなら保存しない。
         *
         * 次のCronでこの人だけ
         * 自動的に再試行される。
         */

        console.error(
          `redeem error
code=${code}
name=${member.player_name}
player=${member.player_id}`,
          error,
        );

        continue;
      }


      console.log(
        "redeem result:",
        {
          code,
          name:
            member.player_name,
          player:
            member.player_id,
          errCode:
            result.errCode,
          message:
            result.message,
        },
      );


      /*
       * 未知のエラーコード・一時エラー。
       *
       * DBへ保存しないので
       * 次回Cronで再試行。
       */
      if (
        !finalCodes.has(
          String(result.errCode),
        )
      ) {

        console.log(
          `retry later:
code=${code}
player=${member.player_id}
err=${result.errCode}
message=${result.message}`,
        );

        continue;
      }


      /*
       * 最終結果をD1へ保存。
       */
      try {

        await env.MEMBERS_DB.prepare(`
          INSERT OR REPLACE
          INTO processed_codes
          (
            code,
            member_id,
            err_code,
            message
          )
          VALUES (?, ?, ?, ?)
        `)
          .bind(
            code,
            member.id,
            String(result.errCode),
            String(
              result.message || "",
            ),
          )
          .run();

      } catch (error) {

        console.error(
          `DB save error:
code=${code}
player=${member.player_id}`,
          error,
        );
      }
    }


    /*
     * =====================================================
     * ⑦ 未処理人数を確認
     * =====================================================
     */

    const remainingRow =
      await env.MEMBERS_DB.prepare(`
        SELECT COUNT(*) AS total

        FROM members m

        LEFT JOIN processed_codes p
          ON p.member_id = m.id
          AND p.code = ?

        WHERE
          m.active = 1
          AND p.member_id IS NULL
      `)
        .bind(code)
        .first();


    const remaining =
      Number(
        remainingRow?.total || 0,
      );


    console.log(
      `code=${code} remaining=${remaining}`,
    );


    /*
     * =====================================================
     * ⑧ まだ残っている
     * =====================================================
     *
     * Discordには途中結果を送らない。
     *
     * 次回Cronで続きを処理する。
     */

    if (remaining > 0) {
      return;
    }


    /*
     * =====================================================
     * ⑨ 全員完了
     * =====================================================
     *
     * 今回処理した人数ではなく、
     * D1に保存された全員分を集計する。
     */

    const totals =
      await env.MEMBERS_DB.prepare(`
        SELECT

          SUM(
            CASE
              WHEN p.err_code = '20000'
              THEN 1
              ELSE 0
            END
          ) AS success,

          SUM(
            CASE
              WHEN p.err_code IN (
                '40008',
                '40011'
              )
              THEN 1
              ELSE 0
            END
          ) AS already,

          SUM(
            CASE
              WHEN p.err_code NOT IN (
                '20000',
                '40008',
                '40011'
              )
              THEN 1
              ELSE 0
            END
          ) AS failed,

          COUNT(*) AS total

        FROM processed_codes p

        INNER JOIN members m
          ON m.id = p.member_id

        WHERE
          p.code = ?
          AND m.active = 1
      `)
        .bind(code)
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

    const total =
      Number(
        totals?.total || 0,
      );


    /*
     * =====================================================
     * ⑩ Discord通知済みか確認
     * =====================================================
     */

    const job =
      await env.MEMBERS_DB.prepare(`
        SELECT notified
        FROM code_jobs
        WHERE code = ?
      `)
        .bind(code)
        .first();


    if (
      Number(job?.notified || 0) === 1
    ) {

      console.log(
        `already notified: ${code}`,
      );

      return;
    }


    /*
     * =====================================================
     * ⑪ Discordへ最終結果を1回だけ送信
     * =====================================================
     */

    const content =
      `🎁 **ギフトコード自動交換結果**
コード：\`${code}\`

✅ 受取成功：${success}人
☑️ 受取済み：${already}人
🔄 再試行待ち：0人
⚠️ その他：${failed}人

🏁 全登録者の処理完了：${total}人`;


    await sendDiscord(
      env,
      content,
    );


    /*
     * Discord送信に成功してから
     * notified=1にする。
     *
     * Discord送信自体が失敗した場合は
     * 次回Cronで再送できる。
     */
    await env.MEMBERS_DB.prepare(`
      UPDATE code_jobs
      SET notified = 1
      WHERE code = ?
    `)
      .bind(code)
      .run();


    console.log(
      `completed:
code=${code}
success=${success}
already=${already}
failed=${failed}
total=${total}`,
    );


  } finally {

    /*
     * =====================================================
     * ⑫ ロック解除
     * =====================================================
     */

    try {

      await env.MEMBERS_DB.prepare(`
        UPDATE code_jobs
        SET locked_until = 0
        WHERE code = ?
      `)
        .bind(code)
        .run();

    } catch (error) {

      console.error(
        "unlock error:",
        error,
      );
    }
  }
}
