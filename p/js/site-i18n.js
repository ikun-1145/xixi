/*
 * Sunland site-wide language runtime.
 *
 * The home page owns the language choice through localStorage.lang. Every
 * public page loads this file and renders with the same choice. The runtime is
 * intentionally dependency-free so every HTML file remains directly usable.
 */
(function initSiteI18n(global) {
  "use strict";

  const STORAGE_KEY = "lang";
  const SUPPORTED_LANGUAGES = Object.freeze(["zh", "zh-Hant", "en", "ja", "ko", "es"]);
  const HTML_LANG = Object.freeze({
    zh: "zh-Hans",
    "zh-Hant": "zh-Hant",
    en: "en",
    ja: "ja",
    ko: "ko",
    es: "es",
  });
  const LANGUAGE_DETAILS = Object.freeze({
    zh: Object.freeze({ label: "简体中文", flag: "p/flags/cn.svg" }),
    "zh-Hant": Object.freeze({ label: "繁體中文", flag: "p/flags/cn.svg" }),
    en: Object.freeze({ label: "English", flag: "p/flags/gb.svg" }),
    ja: Object.freeze({ label: "日本語", flag: "p/flags/jp.svg" }),
    ko: Object.freeze({ label: "한국어", flag: "p/flags/kr.svg" }),
    es: Object.freeze({ label: "Español", flag: "p/flags/es.svg" }),
  });

  const rows = [
    // Common shell and navigation.
    ["页面加载中", "Page loading", "ページを読み込み中"],
    ["语言切换", "Language selector", "言語切り替え"],
    ["加载中", "Loading", "読み込み中"],
    ["加载中...", "Loading...", "読み込み中..."],
    ["加载中…", "Loading…", "読み込み中…"],
    ["← 返回主页", "← Back to Home", "← ホームへ戻る"],
    ["← 返回首页", "← Back to Home", "← ホームへ戻る"],
    ["返回主页", "Back to Home", "ホームへ戻る"],
    ["返回首页", "Back to Home", "ホームへ戻る"],
    ["返回现实", "Return to Reality", "現実へ戻る"],
    ["© 2024–2026 霜蓝 · All Rights Reserved.", "© 2024–2026 Frost · All Rights Reserved.", "© 2024–2026 フロスト · All Rights Reserved."],
    ["Copyright © 2024-2026 霜蓝, All Rights Reserved.", "Copyright © 2024-2026 Frost. All Rights Reserved.", "Copyright © 2024-2026 フロスト. All Rights Reserved."],
    ["关闭", "Close", "閉じる"],
    ["取消", "Cancel", "キャンセル"],
    ["确认", "Confirm", "確認"],
    ["删除", "Delete", "削除"],
    ["复制", "Copy", "コピー"],
    ["已复制 ✓", "Copied ✓", "コピーしました ✓"],
    ["复制失败", "Copy failed", "コピーに失敗しました"],
    ["未知", "Unknown", "不明"],
    ["无", "None", "なし"],
    ["未登录", "Not signed in", "未ログイン"],
    ["请先登录", "Please sign in first", "先にログインしてください"],
    ["退出登录", "Sign out", "ログアウト"],
    ["设置", "Settings", "設定"],

    // Home page.
    ["霜蓝的个人主页", "Frost's Personal Website", "フロストのホームページ"],
    ["如果你愿意支持我的创作", "If you'd like to support my work", "創作を応援していただけるなら"],
    ["请先登录后继续", "Sign in to continue", "続行するにはログインしてください"],
    ["使用 GitHub 登录", "Continue with GitHub", "GitHub でログイン"],
    ["使用 Google 登录", "Continue with Google", "Google でログイン"],
    ["关闭对话框", "Close dialog", "ダイアログを閉じる"],
    ["霜蓝的头像", "Frost's avatar", "フロストのアバター"],
    ["站内导航", "Site navigation", "サイト内ナビゲーション"],
    ["AI 助手", "AI Assistant", "AI アシスタント"],
    ["对话 / 编程 / 创作", "Chat / Code / Create", "対話 / コーディング / 創作"],

    // Follow and contact pages.
    ["关注我们 - 霜蓝", "Follow Me - Frost", "フォロー - フロスト"],
    ["关注我们", "Follow Me", "フォロー"],
    ["全网搜索霜蓝，获取更多动态：", "Search for Frost across these platforms for more updates:", "各プラットフォームでフロストを検索して、最新情報をご覧ください："],
    ["B站", "Bilibili", "Bilibili"],
    ["抖音", "Douyin", "Douyin"],
    ["快手", "Kuaishou", "Kuaishou"],
    ["小红书", "Xiaohongshu", "Xiaohongshu"],
    ["IT之家", "ITHome", "ITHome"],
    ["联系我们 - 霜蓝", "Contact - Frost", "連絡先 - フロスト"],
    ["联系我们", "Contact", "連絡先"],
    ["Primary Contact", "Primary Contact", "主な連絡先"],
    ["复制邮箱", "Copy Email", "メールをコピー"],
    ["点击图标访问我的社交平台", "Select an icon to visit my social profiles", "アイコンを選択してSNSプロフィールを開く"],

    // Existing content pages also use the shared runtime for metadata,
    // accessibility labels, and first paint before their legacy i18n runs.
    ["兽设介绍 - 霜蓝", "Character Design - Frost", "キャラクター紹介 - フロスト"],
    ["霜蓝 - 兽设介绍", "Frost - Character Design", "フロスト - キャラクター紹介"],
    ["霜蓝是一位以冰蓝色为主题的原创形象，象征着冷静与智慧。", "Frost is an original icy-blue character representing calmness and wisdom.", "フロストは氷のような青をテーマにしたオリジナルキャラクターで、冷静さと知性を象徴しています。"],
    ["以下为霜蓝的双视图展示：", "Front and back views of Frost:", "フロストの前後ビューです："],
    ["霜蓝双视图", "Front and back views of Frost", "フロストの前後ビュー"],
    ["霜蓝双视图 - 有头发版", "Front and back views of Frost - with hair", "フロストの前後ビュー - 髪あり"],
    ["版权信息 - 霜蓝", "Copyright - Frost", "著作権情報 - フロスト"],
    ["版权信息", "Copyright", "著作権情報"],
    ["本站所有素材（包括头像、兽设图、配色方案等）均为原创，仅供展示用途，未经许可不得转载或商用。", "All materials on this site, including the avatar, character artwork, and color schemes, are original and for display only. Reproduction or commercial use without permission is prohibited.", "本サイトの素材（アバター、キャラクター画像、配色など）はすべてオリジナルで、展示目的に限られます。無断転載・商用利用は禁止です。"],
    ["版权证书", "Copyright certificate", "著作権証明書"],
    ["评论留言 - 霜蓝", "Comments - Frost", "コメント - フロスト"],
    ["评论留言", "Comments", "コメント"],
    ["实时粉丝数 - 霜蓝", "Live Follower Count - Frost", "フォロワー数 - フロスト"],
    ["实时粉丝数", "Live Follower Count", "フォロワー数"],
    ["感谢大家的支持与陪伴！", "Thank you for all your support!", "いつも応援ありがとうございます！"],
    ["数据更新时间：", "Last updated: ", "更新日時："],
    ["小游戏", "Mini Game", "ミニゲーム"],
    ["游戏结束", "Game Over", "ゲームオーバー"],
    ["再来一局", "Play Again", "もう一度"],
    ["点击屏幕开始", "Tap to Start", "タップして開始"],
    ["最高", "Best", "最高"],
    ["游戏画面", "Game canvas", "ゲーム画面"],

    // Study plan.
    ["Project 2028 · 留学规划", "Project 2028 · Study Abroad Plan", "Project 2028 · 留学計画"],
    ["个人留学战略记录", "Personal Study Abroad Strategy", "個人留学戦略の記録"],
    ["不是赌一次机会，而是构建胜率。", "Don't bet on one chance—build the odds.", "一度の機会に賭けるのではなく、成功確率を高める。"],
    ["石の上にも三年", "Perseverance pays off", "石の上にも三年"],
    ["坚持三年，寒石亦暖。", "Persist long enough, and even cold stone grows warm.", "三年続ければ、冷たい石も温まる。"],
    ["这不是一份冲刺计划，而是一套能力构建实验。", "This is not a sprint plan, but an experiment in building capability.", "これは短期決戦の計画ではなく、力を築くための実験です。"],
    ["每一次考试，都是一次系统验证。", "Every exam is a validation of the system.", "一つひとつの試験が、仕組みを検証する機会です。"],
    ["目标不是押注一次成功，而是不断提高成功概率。", "The goal is not to bet on one success, but to keep improving the probability of success.", "目標は一度の成功に賭けることではなく、成功確率を継続的に高めることです。"],
    ["阶段时间轴", "Timeline", "タイムライン"],
    ["日语学习启动 · N5 完成", "Japanese study begins · N5 completed", "日本語学習開始 · N5修了"],
    ["✓ 已完成", "✓ Completed", "✓ 完了"],
    ["第二次学考完成", "Second academic exam completed", "学考2回目完了"],
    ["托福强化训练 · 能力扩展", "TOEFL intensive training · Skill expansion", "TOEFL強化訓練 · 能力拡張"],
    ["第一次 EJU", "First EJU", "第1回EJU"],
    ["第一次 EJU（试水）", "First EJU (trial run)", "第1回EJU（試験受験）"],
    ["第一次真实检验当前能力结构。", "The first real test of the current skill structure.", "現在の能力構成を初めて実地で検証します。"],
    ["赴日语校 · 第三次学考", "Move to Japan · Third academic exam", "日本語学校入学 · 学考3回目"],
    ["第二次 EJU · 高中毕业", "Second EJU · High school graduation", "第2回EJU · 高校卒業"],
    ["第三次 EJU · 冲高分", "Third EJU · Aim for a higher score", "第3回EJU · 高得点を目指す"],
    ["决定申请区间与最终策略走向。", "Determine the application range and final strategy.", "出願範囲と最終戦略を決定します。"],
    ["校内考", "University internal exam", "校内試験"],
    ["目标录取 🎯", "Target admission 🎯", "目標合格 🎯"],
    ["阶段性目标达成。", "Milestone achieved.", "段階目標を達成。"],
    ["这不是誓言，而是当前最优假设。", "Not a promise. A working hypothesis.", "誓いではなく、現時点での最適な仮説です。"],
    ["2028年4月 本科入学 · 多轮迭代规划", "April 2028 undergraduate enrollment · Iterative planning", "2028年4月 入学 · 多段階戦略"],

    // Hidden-layer pages.
    ["Hidden Layer · 霜蓝协议", "Hidden Layer · Frost Protocol", "Hidden Layer · フロスト・プロトコル"],
    ["霜蓝协议 · Hidden Layer", "Frost Protocol · Hidden Layer", "フロスト・プロトコル · Hidden Layer"],
    ["> 你已穿过主界面。", "> You have crossed beyond the main interface.", "> メイン画面の向こう側へ到達しました。"],
    ["> 这里不是展示区。", "> This is not the showcase layer.", "> ここは展示エリアではありません。"],
    ["> 这里是正在思考的部分。", "> This is the part that is still thinking.", "> ここは思考が続いている領域です。"],
    ["> 项目状态：进行中", "> Project status: In progress", "> プロジェクト状態：進行中"],
    ["> 当前维度：未公开层", "> Current dimension: Undisclosed layer", "> 現在の次元：非公開レイヤー"],
    ["有些东西不会出现在首页。", "Some things never appear on the home page.", "ホームページには現れないものもあります。"],
    ["但它们一直在运行。", "But they are always running.", "けれど、それらはずっと動き続けています。"],
    ["霜蓝@hidden-layer:~$", "frost@hidden-layer:~$", "frost@hidden-layer:~$"],

    // AI chat shell.
    ["+ 新对话", "+ New Chat", "+ 新しいチャット"],
    ["新对话", "New Chat", "新しいチャット"],
    ["搜索历史对话", "Search chat history", "チャット履歴を検索"],
    ["今日剩余 20 次", "20 messages left today", "本日あと20回"],
    ["下载公测版", "Download Beta", "ベータ版をダウンロード"],
    ["升级 Pro", "Upgrade to Pro", "Pro にアップグレード"],
    ["想聊点什么？", "What would you like to talk about?", "何を話しましょうか？"],
    ["有问题，尽管问", "Ask me anything", "何でも聞いてください"],
    ["上传文件", "Upload file", "ファイルをアップロード"],
    ["深度思考", "Deep thinking", "深い思考"],
    ["正在更新…", "Updating…", "更新中…"],
    ["请在 Safari 中打开", "Open in Safari", "Safari で開いてください"],
    ["点击右上角「···」或分享按钮", "Tap “···” or the Share button in the top-right", "右上の「···」または共有ボタンをタップ"],
    ["选择 “在 Safari 中打开”", "Choose “Open in Safari”", "「Safariで開く」を選択"],
    ["无法自动跳转（iOS限制）", "Automatic redirection is unavailable due to iOS restrictions", "iOSの制限により自動で移動できません"],
    ["添加到主屏幕", "Add to Home Screen", "ホーム画面に追加"],
    ["点击下方分享按钮 → 选择 “添加到主屏幕”", "Tap Share below → choose “Add to Home Screen”", "下の共有ボタン →「ホーム画面に追加」を選択"],
    ["不再提示", "Don't show again", "今後表示しない"],
    ["登录已过期，请重新登录", "Your session has expired. Please sign in again.", "ログインの有効期限が切れました。再度ログインしてください。"],
    ["开通处理中，付款成功后约 1-2 分钟自动生效，可稍后刷新页面", "Activation is processing. It should take effect 1–2 minutes after payment; refresh later.", "有効化を処理中です。支払い後1〜2分ほどで反映されます。後ほど再読み込みしてください。"],
    ["支付成功 🎉", "Payment successful 🎉", "支払いが完了しました 🎉"],
    ["请复制错误信息发送给开发者", "Copy the error details and send them to the developer", "エラー情報をコピーして開発者へ送ってください"],
    ["没找到相关对话", "No matching chats found", "該当するチャットが見つかりません"],
    ["删除对话", "Delete chat", "チャットを削除"],
    ["💎 Pro · 无限使用", "💎 Pro · Unlimited", "💎 Pro · 無制限"],
    ["Sunland AI · Beta 暂不支持深度思考", "Sunland AI · Beta does not support deep thinking yet", "Sunland AI · Beta は深い思考にまだ対応していません"],
    ["Sunland AI · Beta 暂不支持文件上传", "Sunland AI · Beta does not support file uploads yet", "Sunland AI · Beta はファイルアップロードにまだ対応していません"],
    ["当前对话已绑定 Sunland AI。请新建对话以切换模型。", "This chat is locked to Sunland AI. Start a new chat to switch models.", "このチャットは Sunland AI に固定されています。モデルを切り替えるには新しいチャットを作成してください。"],
    ["当前对话已绑定 DeepSeek。请新建对话以切换模型。", "This chat is locked to DeepSeek. Start a new chat to switch models.", "このチャットは DeepSeek に固定されています。モデルを切り替えるには新しいチャットを作成してください。"],
    ["深度思考是 Pro 功能", "Deep thinking is a Pro feature", "深い思考は Pro 機能です"],
    ["升级后可开启深度思考模式，并解锁无限次对话。", "Upgrade to enable deep thinking and unlimited chats.", "アップグレードすると、深い思考モードと無制限チャットを利用できます。"],
    ["稍后再说", "Maybe later", "後で"],
    ["DeepSeek V4 Pro 为 Pro 专属", "DeepSeek V4 Pro is exclusive to Pro", "DeepSeek V4 Pro は Pro 限定です"],
    ["当前模型为 DeepSeek V4 Pro 该模型仅对 Pro 用户开放", "The current model is DeepSeek V4 Pro. It is available to Pro users only.", "現在のモデルは DeepSeek V4 Pro です。Pro ユーザーのみ利用できます。"],
    ["继续使用 Flash", "Continue with Flash", "Flash を使い続ける"],
    ["今日次数已用完 😢", "Today's free messages are used up 😢", "本日の無料回数を使い切りました 😢"],
    ["每天限免 20 次，明天自动重置。 支付 10 元可永久解锁无限使用。", "You receive 20 free messages per day, reset tomorrow. Pay ¥10 once to unlock unlimited use permanently.", "1日20回まで無料で、明日リセットされます。¥10の一度払いで無制限利用を永久に解放できます。"],
    ["支付 10 元（永久）", "Pay ¥10 (permanent)", "¥10を支払う（永久）"],
    ["激活成功", "Activated", "有効化しました"],
    ["已解锁 Pro · 无限使用", "Pro unlocked · Unlimited use", "Pro 解放 · 無制限利用"],
    ["输入激活码", "Enter activation code", "アクティベーションコードを入力"],
    ["激活", "Activate", "有効化"],
    ["激活中...", "Activating...", "有効化中..."],
    ["你已经激活过了", "Your account is already activated", "このアカウントはすでに有効化されています"],
    ["请输入激活码", "Enter an activation code", "アクティベーションコードを入力してください"],
    ["验证中...", "Verifying...", "確認中..."],
    ["激活码查询失败", "Unable to check the activation code", "アクティベーションコードを確認できませんでした"],
    ["激活码不存在", "Activation code not found", "アクティベーションコードが見つかりません"],
    ["已被他人使用", "This code has already been used", "このコードはすでに使用されています"],
    ["激活失败，请稍后再试", "Activation failed. Please try again later.", "有効化に失敗しました。後でもう一度お試しください。"],
    ["已激活 ∞", "Activated ∞", "有効化済み ∞"],
    ["请先登录后再开通 Pro", "Sign in before upgrading to Pro", "Pro にアップグレードする前にログインしてください"],
    ["停止当前对话生成", "Stop generating", "生成を停止"],
    ["发送消息", "Send message", "メッセージを送信"],
    ["确定删除这个对话吗？删除后无法恢复。", "Delete this chat? This cannot be undone.", "このチャットを削除しますか？元に戻せません。"],
    ["暂时无法删除这个对话，请稍后再试。", "Unable to delete this chat right now. Please try again later.", "現在このチャットを削除できません。後でもう一度お試しください。"],
    ["对话已删除。", "Chat deleted.", "チャットを削除しました。"],
    ["用户上传的图片", "User-uploaded image", "ユーザーがアップロードした画像"],
    ["抱歉，这条内容包含敏感或不文明用语，我无法继续回答。请修改后再发送。", "Sorry, this message contains sensitive or abusive language. Please revise it and try again.", "申し訳ありません。このメッセージには不適切またはセンシティブな表現が含まれています。修正して再送してください。"],
    ["内容未通过审核，请修改后再发送", "This message did not pass the safety check. Please revise it and try again.", "このメッセージは安全確認を通過しませんでした。修正して再送してください。"],
    ["Sunland AI · Beta 暂时出了点问题，请稍后重试", "Sunland AI · Beta encountered a temporary problem. Please try again later.", "Sunland AI · Beta で一時的な問題が発生しました。後でもう一度お試しください。"],
    ["响应较慢，请稍等…", "The response is taking longer than usual…", "応答に時間がかかっています…"],
    ["登录状态已失效，请重新登录", "Your session is no longer valid. Please sign in again.", "ログイン状態が無効です。再度ログインしてください。"],
    ["登录状态好像出了点问题，请重新登录后再试一下。", "There seems to be a problem with your session. Please sign in again.", "ログイン状態に問題があるようです。再度ログインしてください。"],
    ["今天的使用次数已达上限，请稍后再试", "You have reached today's usage limit. Please try again later.", "本日の利用上限に達しました。後でもう一度お試しください。"],
    ["🧠 思考过程", "🧠 Reasoning", "🧠 思考過程"],
    ["请求异常，请稍后重试", "Request failed. Please try again later.", "リクエストに失敗しました。後でもう一度お試しください。"],
    ["发送过快", "You're sending too quickly", "送信が速すぎます"],
    ["正在删除这个对话，请稍候。", "Deleting this chat…", "チャットを削除しています…"],
    ["好像还没有输入内容呢，可以跟我说点什么。", "It looks like the message is empty—tell me something.", "まだ何も入力されていないようです。何か話しかけてください。"],
    ["操作太快了，慢一点 😅", "A little too fast—please slow down 😅", "操作が速すぎます。少し待ってください 😅"],
    ["文件读取失败", "Unable to read the file", "ファイルを読み込めませんでした"],
    ["消息处理失败，请稍后重试", "Unable to process the message. Please try again later.", "メッセージを処理できませんでした。後でもう一度お試しください。"],
    ["即将前往爱发电支付。 请选择「月付」方案（¥10 / 月）即可——付款成功后将自动开通【永久 Pro】， 无需多选月份，多付不会增加权益。 确认前往支付？", "You are about to continue to Afdian. Choose the monthly plan (¥10/month); payment permanently unlocks Pro. Selecting extra months does not add benefits. Continue to payment?", "愛発電の支払いページへ移動します。「月額」プラン（¥10/月）を選ぶと、支払い完了後に永久Proが有効になります。複数月を選んでも特典は増えません。支払いへ進みますか？"],
    ["深度思考已开启 🧠", "Deep thinking enabled 🧠", "深い思考を有効にしました 🧠"],
    ["深度思考已关闭", "Deep thinking disabled", "深い思考を無効にしました"],

    // Login page.
    ["登录 Sunland AI · Beta", "Sign in to Sunland AI · Beta", "Sunland AI · Beta にログイン"],
    ["输入邮箱获取验证码，无需注册", "Enter your email to receive a verification code—no registration required", "メールアドレスを入力して認証コードを受け取れます。登録は不要です"],
    ["邮箱", "Email", "メールアドレス"],
    ["输入邮箱", "Enter email", "メールアドレスを入力"],
    ["验证码", "Verification code", "認証コード"],
    ["输入验证码", "Enter verification code", "認証コードを入力"],
    ["发送验证码", "Send code", "認証コードを送信"],
    ["我已阅读并同意", "I have read and agree to", "以下を読み、同意します"],
    ["《用户协议》", "Terms of Service", "利用規約"],
    ["和", "and", "および"],
    ["《隐私政策》", "Privacy Policy", "プライバシーポリシー"],
    ["登录", "Sign in", "ログイン"],
    ["验证脚本加载异常，请刷新重试", "The verification script did not load correctly. Refresh and try again.", "認証スクリプトを読み込めませんでした。再読み込みしてお試しください。"],
    ["验证脚本加载失败，请检查网络或稍后重试", "Unable to load the verification script. Check your connection or try again later.", "認証スクリプトを読み込めませんでした。ネットワークを確認するか、後でもう一度お試しください。"],
    ["人机验证加载失败", "Human verification failed to load", "本人確認を読み込めませんでした"],
    ["验证失败", "Verification failed", "認証に失敗しました"],
    ["请输入邮箱", "Enter your email", "メールアドレスを入力してください"],
    ["邮箱格式错误", "Enter a valid email address", "有効なメールアドレスを入力してください"],
    ["人机验证加载中...", "Loading human verification...", "本人確認を読み込み中..."],
    ["发送中...", "Sending...", "送信中..."],
    ["服务器异常", "Server error", "サーバーエラー"],
    ["验证码已发送（有效期约5分钟）", "Verification code sent (valid for about 5 minutes)", "認証コードを送信しました（有効時間は約5分です）"],
    ["网络连接失败（API不可达）", "Network connection failed (API unavailable)", "ネットワーク接続に失敗しました（APIに接続できません）"],
    ["发送验证码失败", "Unable to send the verification code", "認証コードを送信できませんでした"],
    ["请先同意用户协议", "Agree to the Terms of Service first", "先に利用規約へ同意してください"],
    ["验证码格式错误", "Enter a valid verification code", "有効な認証コードを入力してください"],
    ["服务器返回异常", "Unexpected server response", "サーバーから予期しない応答が返されました"],
    ["接口未返回JSON", "The API did not return JSON", "APIがJSONを返しませんでした"],
    ["验证码错误或已过期", "The verification code is incorrect or expired", "認証コードが正しくないか、有効期限が切れています"],
    ["请求过于频繁，请稍后再试", "Too many requests. Please try again later.", "リクエストが多すぎます。後でもう一度お試しください。"],
    ["服务器开小差了", "The server is temporarily unavailable", "サーバーが一時的に利用できません"],
    ["登录成功", "Signed in", "ログインしました"],
    ["网络异常（可能被拦截或断网）", "Network error (the request may be blocked or offline)", "ネットワークエラー（遮断またはオフラインの可能性があります）"],
    ["人机验证失效，请重新验证", "Human verification expired. Please verify again.", "本人確認の有効期限が切れました。もう一度確認してください。"],
    ["请求超时，请重试", "Request timed out. Please try again.", "リクエストがタイムアウトしました。もう一度お試しください。"],
    ["登录异常", "Sign-in error", "ログインエラー"],

    // AI settings.
    ["设置 - Sunland AI · Beta", "Settings - Sunland AI · Beta", "設定 - Sunland AI · Beta"],
    ["普通用户", "Standard user", "一般ユーザー"],
    ["点击头像上传新头像", "Select the avatar to upload a new image", "アバターを選択して新しい画像をアップロード"],
    ["昵称", "Display name", "表示名"],
    ["账号", "Account", "アカウント"],
    ["用户 ID", "User ID", "ユーザーID"],
    ["你的唯一标识", "Your unique identifier", "あなた固有の識別子"],
    ["今日使用", "Today's usage", "本日の利用状況"],
    ["剩余次数", "Messages remaining", "残り回数"],
    ["每天重置 20 次免费额度", "20 free messages reset daily", "毎日20回の無料枠がリセットされます"],
    ["会员", "Membership", "メンバーシップ"],
    ["霜蓝 Pro", "Frost Pro", "フロスト Pro"],
    ["一次付费，永久解锁", "One-time payment, permanent access", "一度の支払いで永久解放"],
    ["无限次对话", "Unlimited chats", "チャット無制限"],
    ["深度思考模式", "Deep thinking mode", "深い思考モード"],
    ["优先响应速度", "Priority response speed", "優先応答"],
    ["永久有效", "Permanent", "永久有効"],
    ["立即升级 · ¥10 永久", "Upgrade now · ¥10 permanent", "今すぐアップグレード · ¥10 永久"],
    ["Sunland AI · Beta 数据管理", "Sunland AI · Beta Data Management", "Sunland AI · Beta データ管理"],
    ["姓名记忆", "Name memory", "名前の記憶"],
    ["只让 Sunland AI 忘记你的名字", "Only make Sunland AI forget your name", "Sunland AI にあなたの名前だけを忘れさせます"],
    ["清除姓名", "Clear name", "名前を消去"],
    ["用户教学知识", "User-taught knowledge", "ユーザーが教えた知識"],
    ["清除你主动教给 Sunland AI 的知识", "Clear knowledge you explicitly taught Sunland AI", "Sunland AI に教えた知識を消去します"],
    ["清除知识", "Clear knowledge", "知識を消去"],
    ["已教给 Sunland AI 的知识", "Knowledge taught to Sunland AI", "Sunland AI に教えた知識"],
    ["正在读取", "Loading", "読み込み中"],
    ["正在读取教学知识", "Loading taught knowledge", "教えた知識を読み込み中"],
    ["隐私与诊断", "Privacy & Diagnostics", "プライバシーと診断"],
    ["Beta 诊断（仅本地）", "Beta diagnostics (local only)", "ベータ診断（ローカルのみ）"],
    ["默认关闭，可随时清除", "Off by default and clearable at any time", "初期設定ではオフ。いつでも消去できます"],
    ["参与本地 Beta 诊断后，Sunland AI 会在此设备上统计匿名的理解结果和性能分桶，用于帮助改进 Beta 体验。诊断不会自动上传，也不包含对话内容、姓名、教学知识或账号标识。", "When enabled, Sunland AI stores anonymous understanding outcomes and performance buckets on this device to improve the Beta. Diagnostics are never uploaded automatically and contain no chat content, names, taught knowledge, or account identifiers.", "有効にすると、ベータ版の改善に役立てるため、匿名の理解結果と性能区分がこの端末に保存されます。診断は自動送信されず、会話内容、名前、教えた知識、アカウント識別子は含まれません。"],
    ["默认关闭，仅保存在当前设备", "Off by default; stored only on this device", "初期設定ではオフ。この端末にのみ保存"],
    ["不会自动上传，不包含聊天内容、姓名、用户教学知识或账号标识", "Never uploaded automatically; contains no chats, names, taught knowledge, or account identifiers", "自動送信されず、会話、名前、教えた知識、アカウント識別子を含みません"],
    ["可以随时关闭，也可以单独清除已有诊断数据", "Turn it off at any time or clear saved diagnostics separately", "いつでもオフにでき、保存済みの診断データだけを消去することもできます"],
    ["参与本地 Beta 诊断", "Enable local Beta diagnostics", "ローカルベータ診断に参加"],
    ["默认关闭", "Off by default", "初期設定ではオフ"],
    ["暂无本地诊断数据", "No local diagnostic data yet", "ローカル診断データはまだありません"],
    ["Sunland 请求总数", "Total Sunland requests", "Sunland リクエスト総数"],
    ["正常理解", "Understood", "理解"],
    ["澄清", "Clarification", "確認質問"],
    ["未理解", "Not understood", "未理解"],
    ["缺少知识", "Missing knowledge", "知識不足"],
    ["Context 使用", "Context used", "Context 使用"],
    ["Legacy 回退", "Legacy fallback", "Legacy フォールバック"],
    ["副作用阻止", "Side effect blocked", "副作用を阻止"],
    ["安全降级", "Safe fallback", "安全なフォールバック"],
    ["性能分桶", "Performance buckets", "性能区分"],
    ["指标", "Metric", "指標"],
    ["分桶计数", "Bucket counts", "区分別件数"],
    ["总处理耗时", "Total processing time", "総処理時間"],
    ["Semantic 耗时", "Semantic time", "Semantic 処理時間"],
    ["Reasoner 耗时", "Reasoner time", "Reasoner 処理時間"],
    ["Knowledge 数量", "Knowledge count", "Knowledge 件数"],
    ["Reasoner 路径", "Reasoner path", "Reasoner パス"],
    ["直接", "Direct", "直接"],
    ["不可用", "Unavailable", "利用不可"],
    ["· 不可用", "· Unavailable", "· 利用不可"],
    ["· 无", "· None", "· なし"],
    ["查看导出内容", "Preview export", "エクスポート内容を表示"],
    ["复制匿名摘要", "Copy anonymous summary", "匿名サマリーをコピー"],
    ["导出匿名 JSON", "Export anonymous JSON", "匿名JSONをエクスポート"],
    ["清除本地诊断数据", "Clear local diagnostic data", "ローカル診断データを消去"],
    ["开启后，仅从后续完成的 Sunland AI 请求开始统计。", "Once enabled, only subsequently completed Sunland AI requests are counted.", "有効化後に完了した Sunland AI リクエストのみ集計されます。"],
    ["其他", "Other", "その他"],
    ["Sunland AI · Beta · v1.1 · 数据安全存储于云端", "Sunland AI · Beta · v1.1 · Data stored securely in the cloud", "Sunland AI · Beta · v1.1 · データはクラウドに安全に保存されます"],
    ["用户协议", "Terms of Service", "利用規約"],
    ["隐私政策", "Privacy Policy", "プライバシーポリシー"],
    ["匿名诊断导出预览", "Anonymous diagnostics export preview", "匿名診断エクスポートのプレビュー"],
    ["这里显示的 JSON 就是复制或导出的全部内容，不包含聊天原文或账号标识。", "The JSON shown here is the complete copied or exported content. It contains no chat text or account identifiers.", "ここに表示されるJSONがコピーまたはエクスポートされる全内容です。会話本文やアカウント識別子は含まれません。"],
    ["关闭预览", "Close preview", "プレビューを閉じる"],
    ["输入新的昵称", "Enter a new display name", "新しい表示名を入力"],
    ["仅支持 JPG / PNG / WEBP 格式", "Only JPG, PNG, and WEBP are supported", "JPG、PNG、WEBPのみ対応しています"],
    ["图片太大，请选择 8MB 内的图片", "The image is too large. Choose one under 8 MB.", "画像が大きすぎます。8MB未満の画像を選択してください。"],
    ["文件格式异常，请重新选择图片", "The file format is invalid. Choose another image.", "ファイル形式が正しくありません。別の画像を選択してください。"],
    ["正在压缩并上传头像...", "Compressing and uploading avatar...", "アバターを圧縮してアップロード中..."],
    ["头像已保存", "Avatar saved", "アバターを保存しました"],
    ["头像保存失败，请稍后再试", "Unable to save the avatar. Please try again later.", "アバターを保存できませんでした。後でもう一度お試しください。"],
    ["💎 Pro 会员", "💎 Pro member", "💎 Pro メンバー"],
    ["Pro 会员 · 无限次对话", "Pro member · Unlimited chats", "Pro メンバー · チャット無制限"],
    ["已是 Pro 会员", "Pro membership active", "Pro メンバーです"],
    ["深度思考与无限对话已解锁", "Deep thinking and unlimited chats are unlocked", "深い思考と無制限チャットが解放されました"],
    ["确定退出登录？", "Sign out?", "ログアウトしますか？"],

    // Data management and diagnostics actions.
    ["需要重新登录", "Sign in again", "再度ログインが必要です"],
    ["暂时无法读取", "Unable to load", "読み込めません"],
    ["暂时无法读取教学知识，请稍后再试。", "Unable to load taught knowledge. Please try again later.", "教えた知識を読み込めません。後でもう一度お試しください。"],
    ["暂无用户教学知识", "No user-taught knowledge", "ユーザーが教えた知識はありません"],
    ["正在处理，请稍候。", "Processing…", "処理中です…"],
    ["暂时无法完成这个操作，请稍后再试。", "Unable to complete this action. Please try again later.", "この操作を完了できません。後でもう一度お試しください。"],
    ["对应的数据已经不存在，列表已刷新。", "The data no longer exists. The list has been refreshed.", "対象データはすでに存在しません。一覧を更新しました。"],
    ["这条教学知识已删除。", "The taught knowledge was deleted.", "教えた知識を削除しました。"],
    ["确定让 Sunland AI 忘记你的名字吗？聊天记录不会受到影响。", "Make Sunland AI forget your name? Chat history will not be affected.", "Sunland AI にあなたの名前を忘れさせますか？チャット履歴には影響しません。"],
    ["Sunland AI 已忘记你的名字，聊天记录没有受到影响。", "Sunland AI has forgotten your name. Chat history was not affected.", "Sunland AI はあなたの名前を忘れました。チャット履歴には影響していません。"],
    ["确定清除你教给 Sunland AI 的全部知识吗？系统内置知识和聊天记录不会受到影响。", "Clear all knowledge you taught Sunland AI? Built-in knowledge and chat history will not be affected.", "Sunland AI に教えたすべての知識を消去しますか？内蔵知識とチャット履歴には影響しません。"],
    ["你教给 Sunland AI 的知识已清除，系统内置知识和聊天记录没有受到影响。", "The knowledge you taught Sunland AI was cleared. Built-in knowledge and chat history were not affected.", "Sunland AI に教えた知識を消去しました。内蔵知識とチャット履歴には影響していません。"],
    ["开启后，只会在此设备保存匿名聚合数据，不会自动上传。确定参与本地 Beta 诊断吗？", "Only anonymous aggregate data will be stored on this device and it will never upload automatically. Enable local Beta diagnostics?", "匿名の集計データだけがこの端末に保存され、自動送信はされません。ローカルベータ診断を有効にしますか？"],
    ["导出内容只包含上方显示的匿名聚合数据。", "The export contains only the anonymous aggregate data shown above.", "エクスポートには上記の匿名集計データのみが含まれます。"],
    ["确定清除此设备上当前账号的本地 Beta 诊断数据吗？此操作不会删除聊天记录、姓名记忆或教学知识。", "Clear local Beta diagnostics for the current account on this device? This will not delete chats, name memory, or taught knowledge.", "この端末の現在のアカウントにあるローカルベータ診断データを消去しますか？チャット、名前の記憶、教えた知識は削除されません。"],
    ["已开启 · 仅本地", "Enabled · Local only", "有効 · ローカルのみ"],
    ["当前浏览器无法访问本地诊断数据。", "This browser cannot access local diagnostic data.", "このブラウザではローカル診断データにアクセスできません。"],
    ["暂时无法读取本地诊断数据，请稍后再试。", "Unable to read local diagnostic data. Please try again later.", "ローカル診断データを読み込めません。後でもう一度お試しください。"],
    ["本地诊断数据已重置。", "Local diagnostic data was reset.", "ローカル診断データをリセットしました。"],
    ["账号已切换，请确认当前账号后再操作。", "The account changed. Confirm the current account before continuing.", "アカウントが切り替わりました。現在のアカウントを確認してから操作してください。"],
    ["正在确认登录状态。", "Checking sign-in status.", "ログイン状態を確認中です。"],
    ["已开启本地 Beta 诊断。当前不会自动上传任何数据。", "Local Beta diagnostics enabled. No data is uploaded automatically.", "ローカルベータ診断を有効にしました。データは自動送信されません。"],
    ["已停止本地诊断。之前保存的诊断数据仍保留，可使用“清除诊断数据”删除。", "Local diagnostics stopped. Existing data is retained until you clear it.", "ローカル診断を停止しました。保存済みデータは、消去するまで保持されます。"],
    ["暂无本地诊断数据。", "No local diagnostic data yet.", "ローカル診断データはまだありません。"],
    ["匿名诊断摘要已复制。", "Anonymous diagnostics summary copied.", "匿名診断サマリーをコピーしました。"],
    ["匿名诊断 JSON 已导出。", "Anonymous diagnostics JSON exported.", "匿名診断JSONをエクスポートしました。"],
    ["当前账号的本地诊断数据已清除，其他数据没有受到影响。", "Local diagnostics for the current account were cleared. Other data was not affected.", "現在のアカウントのローカル診断データを消去しました。その他のデータには影響していません。"],

    // HuFuBao copilot.
    ["护福宝 HuFuBao · 福瑞评论区 AI 嘴替", "HuFuBao · AI Reply Copilot for Furry Communities", "HuFuBao · ファーリー向けAI返信アシスタント"],
    ["护福宝", "HuFuBao", "HuFuBao"],
    ["你的福瑞评论区 AI 嘴替。复制评论，剩下的交给 AI —— 评论分析、黑话识别、图片识别、回复建议、连续上下文，让每一次回应都更从容。", "Your AI reply copilot for furry communities. Paste a comment and let AI analyze intent, slang, images, response options, and ongoing context.", "ファーリーコミュニティ向けのAI返信アシスタント。コメントを貼り付ければ、意図・スラング・画像・返信案・継続文脈を分析します。"],
    ["🧹 清空上下文", "🧹 Clear context", "🧹 文脈を消去"],
    ["清空上下文", "Clear context", "文脈を消去"],
    ["仅图片", "Image only", "画像のみ"],
    ["Pro · 无限", "Pro · Unlimited", "Pro · 無制限"],
    ["待配置", "Configuration required", "設定が必要です"],
    ["请输入对方评论", "Enter the other person's comment", "相手のコメントを入力"],
    ["把对方的评论粘贴到这里，例如：兽圈都是变态……", "Paste the other person's comment here…", "相手のコメントをここに貼り付けてください…"],
    ["上传图片", "Upload image", "画像をアップロード"],
    ["（点击或拖拽到这里）", "(Click or drag here)", "（クリックまたはここへドラッグ）"],
    ["支持表情包、截图、评论截图，AI 会一起识别分析", "Supports memes and screenshots; AI analyzes them together", "スタンプやスクリーンショットにも対応し、AIがまとめて分析します"],
    ["预览", "Preview", "プレビュー"],
    ["移除图片", "Remove image", "画像を削除"],
    ["回复语气", "Reply tone", "返信のトーン"],
    ["和解", "Reconcile", "和解"],
    ["主动示好，化解矛盾", "Reach out and defuse tension", "歩み寄って対立を和らげる"],
    ["礼貌", "Polite", "丁寧"],
    ["客气得体，给彼此留面子", "Courteous and considerate", "丁寧で、互いの立場を尊重する"],
    ["理性", "Reasoned", "理性的"],
    ["就事论事，冷静讲道理", "Stay calm and focus on the issue", "冷静に事実をもとに話す"],
    ["幽默", "Humorous", "ユーモア"],
    ["轻松调侃，一笑而过", "Keep it light with playful humor", "軽く冗談を交えて受け流す"],
    ["阴阳", "Sarcastic", "皮肉"],
    ["绵里藏针，阴阳怪气", "Polite on the surface, pointed underneath", "柔らかな言葉に皮肉を込める"],
    ["毒舌", "Sharp", "辛口"],
    ["犀利反击，一针见血", "Deliver a sharp, direct comeback", "鋭く核心を突いて反論する"],
    ["火力全开", "Full force", "全力"],
    ["火力拉满，绝不退让", "Maximum intensity, no backing down", "最大火力で一歩も引かない"],
    ["当前调用模型：Claude", "Current model: Claude", "使用中のモデル：Claude"],
    ["弱 · 温和", "Mild · Gentle", "弱 · 穏やか"],
    ["火力 · 强", "Intensity · Strong", "火力 · 強"],
    ["生成建议", "Generate suggestions", "提案を生成"],
    ["粘贴对方的评论（或截图、表情包），选择回复语气，点击「生成建议」", "Paste a comment, screenshot, or meme; choose a tone; then select “Generate suggestions.”", "コメント、スクリーンショット、スタンプを貼り、トーンを選んで「提案を生成」を押してください。"],
    ["护福宝会帮你识别评论意图、看懂黑话、判断是否值得回复，并草拟一段推荐回复。", "HuFuBao identifies intent and slang, assesses whether a reply is worthwhile, and drafts a recommended response.", "HuFuBao が意図やスラングを読み取り、返信する価値を判断し、おすすめの返信案を作成します。"],
    ["需要先登录", "Sign-in required", "ログインが必要です"],
    ["护福宝需要使用你的霜蓝账号，登录后即可免费使用。", "HuFuBao uses your Sunland account and is free after sign-in.", "HuFuBao は Sunland アカウントでログインすると無料で利用できます。"],
    ["前往登录", "Go to sign in", "ログインへ"],
    ["清空上下文？", "Clear context?", "文脈を消去しますか？"],
    ["清空后将结束当前这段对话，下一次生成会重新开始，不再延续之前的评论。", "Clearing ends this conversation. The next generation starts fresh without previous comments.", "消去すると現在の会話が終了し、次回は過去のコメントを引き継がずに新しく始まります。"],
    ["确认清空", "Clear", "消去"],
    ["建议回复", "Reply recommended", "返信を推奨"],
    ["建议忽略", "Ignore recommended", "無視を推奨"],
    ["建议拉黑", "Block recommended", "ブロックを推奨"],
    ["建议举报", "Report recommended", "通報を推奨"],
    ["无需处理", "No action needed", "対応不要"],
    ["仅支持图片", "Images only", "画像のみ対応"],
    ["图片读取失败", "Unable to read the image", "画像を読み込めませんでした"],
    ["图片太大了（上限 15MB）", "The image is too large (15 MB limit)", "画像が大きすぎます（上限15MB）"],
    ["图片处理失败", "Unable to process the image", "画像を処理できませんでした"],
    ["🖼️ 仅图片", "🖼️ Image only", "🖼️ 画像のみ"],
    ["评论分析", "Comment analysis", "コメント分析"],
    ["攻击等级", "Attack level", "攻撃レベル"],
    ["未检测到明显攻击类型", "No clear attack type detected", "明確な攻撃タイプは検出されませんでした"],
    ["建议", "Recommendation", "提案"],
    ["推荐回复", "Recommended reply", "おすすめの返信"],
    ["复制回复", "Copy reply", "返信をコピー"],
    ["已复制", "Copied", "コピーしました"],
    ["复制失败，请手动选择文本", "Copy failed. Select the text manually.", "コピーに失敗しました。テキストを手動で選択してください。"],
    ["建议不要回复。", "We recommend not replying.", "返信しないことをおすすめします。"],
    ["继续回应没有意义，留给它一个安静的角落即可。", "Continuing is unlikely to help; it is better to leave it alone.", "これ以上応じても意味がないため、そのままにしておくのがよいでしょう。"],
    ["💎 无限", "💎 Unlimited", "💎 無制限"],
    ["⚙️ 待配置", "⚙️ Not configured", "⚙️ 未設定"],
    ["额度获取失败", "Unable to load quota", "利用枠を取得できませんでした"],
    ["分析中…", "Analyzing…", "分析中…"],
    ["请输入对方评论，或上传一张图片", "Enter a comment or upload an image", "相手のコメントを入力するか、画像をアップロードしてください"],
    ["对话较长，已自动开启新一段上下文，更早的内容不再延续", "This conversation was long, so a new context started automatically. Earlier content is no longer carried forward.", "会話が長くなったため、新しい文脈を自動で開始しました。以前の内容は引き継がれません。"],
    ["今日免费额度已用完，请明天再来。", "Today's free quota is used up. Please come back tomorrow.", "本日の無料枠を使い切りました。明日またお試しください。"],
    ["今日剩余 0 次", "0 uses left today", "本日あと0回"],
    ["AI 服务尚未配置，请稍后再试", "The AI service is not configured yet. Please try again later.", "AIサービスはまだ設定されていません。後でもう一度お試しください。"],
    ["生成失败，请稍后再试", "Generation failed. Please try again later.", "生成に失敗しました。後でもう一度お試しください。"],
    ["网络异常，请稍后再试", "Network error. Please try again later.", "ネットワークエラーです。後でもう一度お試しください。"],
    ["当前还没有上下文可清空", "There is no context to clear yet", "消去できる文脈はまだありません"],
    ["清空失败，请稍后再试", "Unable to clear context. Please try again later.", "文脈を消去できませんでした。後でもう一度お試しください。"],
    ["已清空上下文，开始新的对话", "Context cleared. A new conversation will begin.", "文脈を消去しました。新しい会話を始めます。"],

    // Donation page.
    ["捐赠支持 - 霜蓝", "Support - Frost", "支援 - フロスト"],
    ["感谢你的支持！💙", "Thank you for your support! 💙", "応援ありがとうございます！💙"],
    ["感谢你的支持！", "Thank you for your support!", "応援ありがとうございます！"],
    ["如果你喜欢本站内容，可以选择一个方式支持我：", "If you enjoy this site, choose a way to support my work:", "このサイトを気に入っていただけたら、次の方法で応援できます："],
    ["请你喝杯咖啡", "Buy me a coffee", "コーヒーをごちそう"],
    ["请你吃顿饭", "Buy me a meal", "食事をごちそう"],
    ["狠狠支持一下", "Big support", "全力で応援"],
    ["选择档位后，扫码支付即可～", "Choose a tier, then scan to pay.", "金額を選び、QRコードを読み取ってお支払いください。"],
    ["微信支付", "WeChat Pay", "WeChat Pay"],
    ["支付宝", "Alipay", "Alipay"],
    ["💖 粉丝鸣谢榜", "💖 Supporter Board", "💖 応援者一覧"],
    ["感谢每一位支持霜蓝的朋友（按时间倒序）", "Thank you to everyone supporting Frost (newest first)", "フロストを応援してくださる皆さんへ（新しい順）"],
    ["加载更多", "Load more", "もっと見る"],
    ["✍ 留下你的支持留言", "✍ Leave a message", "✍ 応援メッセージを書く"],
    ["你的昵称（可留空）", "Your nickname (optional)", "ニックネーム（任意）"],
    ["想对霜蓝说的话（可选）", "Message to Frost (optional)", "フロストへのメッセージ（任意）"],
    ["提交到鸣谢榜", "Submit to the board", "一覧へ送信"],
    ["提交后会显示在榜单中 💙", "Your message will appear on the board 💙", "送信後、一覧に表示されます 💙"],
    ["暂无鸣谢记录，期待你的第一份支持 💙", "No supporter messages yet—yours could be the first 💙", "応援メッセージはまだありません。最初の応援をお待ちしています 💙"],
    ["感谢支持！", "Thank you for your support!", "応援ありがとうございます！"],
    ["刚刚", "Just now", "たった今"],
    ["请先登录再点赞 💙", "Sign in to like this message 💙", "いいねするにはログインしてください 💙"],
    ["请先登录后再提交", "Sign in before submitting", "送信する前にログインしてください"],
    ["未获取到用户身份，请重新登录", "Unable to verify your identity. Please sign in again.", "ユーザー情報を確認できません。再度ログインしてください。"],
    ["请输入留言内容", "Enter a message", "メッセージを入力してください"],
    ["提交中...", "Submitting...", "送信中..."],
    ["提交失败，请稍后再试", "Submission failed. Please try again later.", "送信に失敗しました。後でもう一度お試しください。"],
    ["已提交，感谢你的支持！💙", "Submitted—thank you for your support! 💙", "送信しました。応援ありがとうございます！💙"],
    ["当前金额：¥10", "Amount: ¥10", "金額：¥10"],
    ["当前金额：¥20", "Amount: ¥20", "金額：¥20"],
    ["当前金额：¥50", "Amount: ¥50", "金額：¥50"],
    ["☕ 已选择：咖啡档位，感谢你的温柔支持～", "☕ Coffee tier selected—thank you for your kind support!", "☕ コーヒープランを選択しました。温かい応援をありがとうございます！"],
    ["🍔 已选择：吃饭档位，今天加个鸡腿！", "🍔 Meal tier selected—dinner gets an upgrade today!", "🍔 食事プランを選択しました。今日は少し豪華に！"],
    ["💖 已选择：狠狠爱我档位，真的太感动了！", "💖 Big-support tier selected—I'm truly touched!", "💖 全力応援プランを選択しました。本当にうれしいです！"],

    // Furry-event cards (generated inside the chat area).
    ["天气待临近活动时更新", "Weather updates closer to the event", "天気は開催日が近づいてから更新されます"],
    ["天气", "Weather", "天気"],
    ["地点待公布", "Venue to be announced", "会場は後日発表"],
    ["活动封面", "Event cover", "イベント画像"],
    ["活动详情", "Event details", "イベント詳細"],
    ["携程住宿", "Trip.com stays", "Trip.com 宿泊"],
    ["美团住宿", "Meituan stays", "Meituan 宿泊"],
    ["🐾 正在获取兽聚活动…", "🐾 Loading furry events…", "🐾 ファーリーイベントを取得中…"],
    ["🐾 兽聚信息暂时获取失败，请稍后再试", "🐾 Unable to load furry events right now. Please try again later.", "🐾 ファーリーイベントを取得できませんでした。後でもう一度お試しください。"],
    ["🐾 没有找到相关兽聚活动", "🐾 No matching furry events found", "🐾 該当するファーリーイベントが見つかりません"],
    ["🐾 相关兽聚活动", "🐾 Related furry events", "🐾 関連するファーリーイベント"],
    ["场 · 横向滑动查看更多", "events · Swipe sideways for more", "件 · 横にスワイプして続きを表示"],

    // Download page supplements (its existing key-based translations remain intact).
    ["重新定义智能交互", "Redefining Intelligent Interaction", "インテリジェントな対話を再定義する"],
    ["Sunland AI · Beta — 重新定义智能交互", "Sunland AI · Beta — Redefining Intelligent Interaction", "Sunland AI · Beta — インテリジェントな対話を再定義する"],
    ["深度集成先进大语言模型，为每位用户带来流畅、智能、有温度的对话体验", "Deeply integrated with advanced LLMs to deliver fluid, intelligent, and warm conversations for everyone", "最先端の大規模言語モデルを深く統合し、滑らかで知的、温かみのある対話体験を提供します"],
    ["立即下载", "Download now", "今すぐダウンロード"],
    ["探索更多", "Explore more", "もっと見る"],
    ["核心能力", "Core capabilities", "核心機能"],
    ["不止于对话", "Beyond conversation", "対話を超えて"],
    ["融合前沿 AI 技术，打造全方位智能助手", "Combining cutting-edge AI into an all-around intelligent assistant", "最先端のAI技術を融合した総合アシスタント"],
    ["智能对话", "Smart dialogue", "スマート対話"],
    ["理解上下文，感知情绪，像真人一样自然交流", "Understands context and emotion for natural conversation", "文脈と感情を理解し、自然に対話します"],
    ["多轮深度对话", "Multi-turn deep dialogue", "多ターン深層対話"],
    ["极速响应", "Lightning fast", "高速応答"],
    ["流式输出，毫秒级首字延迟，沟通零等待", "Streaming output with sub-second first-token latency", "ストリーミング出力と高速な初回応答"],
    ["< 500ms 首字延迟", "< 500ms first-token latency", "初回応答 < 500ms"],
    ["深度创作", "Deep creation", "深層創作"],
    ["从文案撰写到创意发散，激发无限灵感", "From copywriting to brainstorming, unlock unlimited inspiration", "文章作成からアイデア発想まで、創造力を引き出します"],
    ["全场景创作辅助", "Creative support for every scenario", "あらゆる場面の創作支援"],
    ["编程助手", "Coding assistant", "コーディング支援"],
    ["代码生成、调试、解释，开发效率倍增", "Generate, debug, and explain code to boost productivity", "コード生成・デバッグ・解説で開発効率を高めます"],
    ["多语言代码支持", "Multi-language code support", "多言語コード対応"],
    ["交互演示", "Live demo", "インタラクションデモ"],
    ["真实的对话体验", "Real conversation experience", "リアルな対話体験"],
    ["沉浸式交互，让每一次对话都充满期待", "Immersive interaction that makes every conversation engaging", "没入感のある対話体験"],
    ["在线", "Online", "オンライン"],
    ["你好，霜蓝！你能帮我写一段关于科技未来的文案吗？", "Hi, Frost! Can you help me write something about the future of technology?", "こんにちは、フロスト！テクノロジーの未来について文章を書いてもらえますか？"],
    ["输入消息...", "Type a message...", "メッセージを入力..."],
    ["下载", "Download", "ダウンロード"],
    ["获取 Sunland AI · Beta", "Get Sunland AI · Beta", "Sunland AI · Beta を入手"],
    ["开启你的智能对话之旅", "Start your intelligent conversation journey", "インテリジェントな対話の旅を始めよう"],
    ["Android 版下载", "Android download", "Android版ダウンロード"],
    ["适用于 Android 5.0 (Lollipop) 及以上版本", "For Android 5.0 (Lollipop) and above", "Android 5.0 (Lollipop) 以降に対応"],
    ["仅支持 Android · Android Only", "Android only", "Android のみ対応"],
    ["立即下载 APK", "Download APK", "APK をダウンロード"],
    ["直链下载", "Direct link", "直接ダウンロード"],
    ["安全可信", "Safe & trusted", "安全・信頼"],
    ["公测免费", "Free Beta", "ベータ無料"],
    ["持续更新", "Continuous updates", "継続的アップデート"],
    ["许可协议", "Terms of Service", "利用規約"],

    // Privacy policy.
    ["Sunland AI · Beta 隐私政策", "Sunland AI · Beta Privacy Policy", "Sunland AI · Beta プライバシーポリシー"],
    ["最后更新：2026-07-25", "Last updated: July 25, 2026", "最終更新日：2026年7月25日"],
    ["我们非常重视您的隐私与数据安全，请在使用前仔细阅读本政策。", "We take your privacy and data security seriously. Please read this policy carefully before using the service.", "当サービスはプライバシーとデータの安全を重視しています。ご利用前に本ポリシーをよくお読みください。"],
    ["一、我们如何收集信息", "1. Information We Collect", "1. 収集する情報"],
    ["我们可能通过以下方式收集信息：", "We may collect information in the following ways:", "当サービスは、次の方法で情報を収集する場合があります："],
    ["1. 您主动提供的信息：", "1. Information you provide:", "1. お客様が提供する情報："],
    ["包括您在使用服务时输入的内容（如对话文本）、邮箱等登录信息。", "This includes content you enter while using the service, such as chat text, and sign-in information such as your email address.", "サービス利用時に入力する会話文などの内容、およびメールアドレスなどのログイン情報が含まれます。"],
    ["2. 自动收集的信息：", "2. Information collected automatically:", "2. 自動的に収集される情報："],
    ["包括设备信息（设备型号、操作系统）、浏览器信息、IP地址、访问日志等。", "This may include device model, operating system, browser information, IP address, and access logs.", "端末モデル、OS、ブラウザ情報、IPアドレス、アクセスログなどが含まれる場合があります。"],
    ["3. 第三方提供的信息：", "3. Information provided by third parties:", "3. 第三者から提供される情報："],
    ["当您使用第三方服务（如人工智能模型接口）时，相关数据可能由第三方处理。", "When you use third-party services, such as AI model APIs, related data may be processed by those third parties.", "AIモデルAPIなどの第三者サービスを利用する場合、関連データが第三者によって処理されることがあります。"],
    ["二、我们如何使用信息", "2. How We Use Information", "2. 情報の利用目的"],
    ["我们收集的信息将用于：", "We use collected information to:", "収集した情報は次の目的で利用します："],
    ["1. 提供、维护和优化服务体验", "1. Provide, maintain, and improve the service", "1. サービスの提供、維持、改善"],
    ["2. 提升系统稳定性与安全性", "2. Improve system stability and security", "2. システムの安定性と安全性の向上"],
    ["3. 防止滥用、欺诈或违法行为", "3. Prevent abuse, fraud, and unlawful activity", "3. 不正利用、詐欺、違法行為の防止"],
    ["4. 改进功能和服务质量", "4. Improve features and service quality", "4. 機能およびサービス品質の改善"],
    ["说明：", "Note:", "注記："],
    ["部分数据可能用于分析或优化服务表现。", "Some data may be used to analyze or optimize service performance.", "一部のデータは、サービス性能の分析または改善に利用される場合があります。"],
    ["三、本地 Beta 诊断", "3. Local Beta Diagnostics", "3. ローカルベータ診断"],
    ["Sunland AI · Beta 的本地诊断默认关闭。只有在您主动开启后，才会在当前设备保存匿名的理解结果与性能分桶等聚合数据。", "Local diagnostics are off by default. Anonymous aggregate data, such as understanding outcomes and performance buckets, is stored on this device only after you enable it.", "ローカル診断は初期設定ではオフです。お客様が有効にした場合に限り、匿名の理解結果や性能区分などの集計データがこの端末に保存されます。"],
    ["本地 Beta 诊断不会自动上传，不包含聊天内容、姓名、用户教学知识或账号标识。您可以在设置页查看、导出或清除这些数据，也可以随时关闭诊断。", "Local Beta diagnostics are never uploaded automatically and contain no chat content, names, user-taught knowledge, or account identifiers. You can view, export, clear, or disable them in Settings.", "ローカルベータ診断は自動送信されず、会話内容、名前、ユーザーが教えた知識、アカウント識別子を含みません。設定画面で表示、エクスポート、消去、無効化できます。"],
    ["关闭诊断不会自动删除此前保存的本地聚合数据；如需删除，请在设置页另行使用“清除本地诊断数据”。本地数据仍可能被同源脚本或能够访问该设备存储的人读取。", "Disabling diagnostics does not automatically delete previously stored aggregate data. To remove it, use “Clear local diagnostic data” in Settings. Local data may still be accessible to same-origin scripts or people with access to the device's storage.", "診断を無効にしても、以前に保存された集計データは自動削除されません。削除するには設定画面の「ローカル診断データを消去」を使用してください。ローカルデータは、同一オリジンのスクリプトや端末ストレージへアクセスできる人に読み取られる可能性があります。"],
    ["四、数据存储与安全", "4. Data Storage and Security", "4. データの保存と安全性"],
    ["1. 您的数据可能存储在云端服务器。", "1. Your data may be stored on cloud servers.", "1. お客様のデータはクラウドサーバーに保存される場合があります。"],
    ["2. 我们会采取合理的安全措施保护数据，但无法保证绝对安全。", "2. We take reasonable measures to protect data, but cannot guarantee absolute security.", "2. 合理的な安全対策を講じますが、完全な安全性を保証することはできません。"],
    ["3. 数据存储时间将根据业务需要和法律要求确定。", "3. Retention periods are determined by operational needs and legal requirements.", "3. 保存期間は、運用上の必要性および法的要件に基づいて決定されます。"],
    ["五、第三方服务与数据传输", "5. Third-Party Services and Data Transfers", "5. 第三者サービスとデータ送信"],
    ["本服务依赖第三方人工智能服务（如 DeepSeek API）。", "The service relies on third-party AI services, such as the DeepSeek API.", "本サービスは、DeepSeek APIなどの第三者AIサービスを利用しています。"],
    ["您理解并同意：", "You understand and agree that:", "お客様は以下を理解し、同意するものとします："],
    ["1. 您的输入内容可能被发送至第三方用于生成结果", "1. Your input may be sent to third parties to generate results", "1. 結果を生成するため、入力内容が第三者へ送信される場合があります"],
    ["2. 第三方可能依据其自身隐私政策处理数据", "2. Third parties may process data under their own privacy policies", "2. 第三者は独自のプライバシーポリシーに基づいてデータを処理する場合があります"],
    ["3. 我们无法完全控制第三方的数据处理行为", "3. We cannot fully control third-party data-processing practices", "3. 第三者によるデータ処理を完全に管理することはできません"],
    ["重要提示：", "Important:", "重要："],
    ["AI服务通常会记录交互数据用于优化模型或服务", "AI services may log interaction data to improve models or services.", "AIサービスは、モデルやサービスの改善のために対話データを記録する場合があります。"],
    ["六、数据共享与披露", "6. Data Sharing and Disclosure", "6. データの共有と開示"],
    ["我们不会向第三方出售您的个人信息，但在以下情况下可能共享：", "We do not sell your personal information, but may share it in the following circumstances:", "個人情報を第三者へ販売することはありませんが、次の場合に共有することがあります："],
    ["1. 法律法规要求或监管机关要求", "1. When required by law or regulators", "1. 法令または監督機関から要求された場合"],
    ["2. 为保障服务安全与正常运行", "2. To protect service security and operation", "2. サービスの安全と正常な運用を確保する場合"],
    ["3. 为防止违法或违规行为", "3. To prevent unlawful or prohibited conduct", "3. 違法または禁止された行為を防止する場合"],
    ["七、您的权利", "7. Your Rights", "7. お客様の権利"],
    ["您有权：", "You may:", "お客様には次の権利があります："],
    ["1. 查询我们收集的个人信息", "1. Ask what personal information we collect", "1. 収集された個人情報を確認する"],
    ["2. 请求删除您的数据（在技术可行范围内）", "2. Request deletion of your data where technically feasible", "2. 技術的に可能な範囲でデータの削除を求める"],
    ["3. 停止使用服务以终止数据处理", "3. Stop using the service to end further processing", "3. サービスの利用を停止し、以後の処理を終了する"],
    ["八、未成年人保护", "8. Protection of Minors", "8. 未成年者の保護"],
    ["本服务不面向未满18周岁的未成年人提供，如您属于未成年人，请在监护人指导下使用。", "The service is not intended for anyone under 18. Minors should use it only with guidance from a guardian.", "本サービスは18歳未満の方を対象としていません。未成年者は保護者の指導のもとで利用してください。"],
    ["九、政策更新", "9. Policy Updates", "9. ポリシーの更新"],
    ["我们可能会不定期更新本隐私政策，更新后继续使用即视为同意最新版本。", "We may update this policy from time to time. Continuing to use the service after an update means you accept the latest version.", "本ポリシーは随時更新される場合があります。更新後も利用を継続した場合、最新版に同意したものとみなされます。"],
    ["十、联系我们", "10. Contact Us", "10. お問い合わせ"],
    ["如您对本政策有任何疑问，可通过以下方式联系我们：", "If you have questions about this policy, contact us at:", "本ポリシーに関するご質問は、次の連絡先までお問い合わせください："],
    ["邮箱：support@sunland.dev", "Email: support@sunland.dev", "メール：support@sunland.dev"],
    ["若您不同意本政策，请停止使用本服务。", "If you do not agree with this policy, stop using the service.", "本ポリシーに同意しない場合は、サービスの利用を中止してください。"],

    // Terms of Service.
    ["Sunland AI · Beta 许可协议", "Sunland AI · Beta Terms of Service", "Sunland AI · Beta 利用規約"],
    ["Sunland AI · Beta 用户服务协议", "Sunland AI · Beta Terms of Service", "Sunland AI · Beta 利用規約"],
    ["最后更新：2026-04-28", "Last updated: April 28, 2026", "最終更新日：2026年4月28日"],
    ["使用本服务即代表您已阅读并同意本协议全部内容。", "By using the service, you confirm that you have read and agree to these Terms.", "本サービスを利用することで、本規約を読み、そのすべてに同意したものとみなされます。"],
    ["一、服务说明", "1. About the Service", "1. サービスについて"],
    ["Sunland AI · Beta（以下简称“本服务”）为基于第三方人工智能模型（如 DeepSeek）提供的智能对话与辅助工具服务。本服务仅作为技术工具，不对生成内容的准确性、完整性或适用性作任何保证。", "Sunland AI · Beta (the “Service”) provides intelligent conversation and assistance tools powered by third-party AI models such as DeepSeek. The Service is a technical tool and does not guarantee the accuracy, completeness, or suitability of generated content.", "Sunland AI · Beta（以下「本サービス」）は、DeepSeekなどの第三者AIモデルを利用した対話および支援ツールです。本サービスは技術的なツールとして提供され、生成内容の正確性、完全性、適合性を保証しません。"],
    ["二、账户与使用", "2. Accounts and Use", "2. アカウントと利用"],
    ["1. 用户需通过邮箱验证方式登录本服务。", "1. Users must sign in through email verification.", "1. ユーザーはメール認証でログインする必要があります。"],
    ["2. 用户应妥善保管账号信息，对其账户行为负责。", "2. Users must protect account information and are responsible for account activity.", "2. ユーザーはアカウント情報を適切に管理し、アカウント上の行為に責任を負います。"],
    ["3. 用户不得将账户用于非法用途或转让他人使用。", "3. Accounts may not be used unlawfully or transferred to others.", "3. アカウントを違法な目的で使用したり、他者へ譲渡したりしてはいけません。"],
    ["三、用户输入与生成内容", "3. User Input and Generated Content", "3. ユーザー入力と生成内容"],
    ["1. 用户对其输入内容（包括文本、指令等）负全部责任，并保证其合法性。", "1. Users are fully responsible for their input, including text and instructions, and must ensure it is lawful.", "1. ユーザーはテキストや指示を含む入力内容に全面的な責任を負い、その適法性を保証するものとします。"],
    ["2. 本服务生成的内容由人工智能模型自动生成，可能存在错误、不准确或不完整。", "2. Content is generated automatically by AI models and may contain errors, inaccuracies, or omissions.", "2. 本サービスの内容はAIモデルにより自動生成され、誤り、不正確さ、不完全さを含む場合があります。"],
    ["3. 用户可在法律允许范围内使用生成内容，但需自行承担相关风险。", "3. Users may use generated content where permitted by law, at their own risk.", "3. ユーザーは法令で認められる範囲で生成内容を利用できますが、関連するリスクは自己負担となります。"],
    ["由于人工智能的特性，不同用户可能获得相似内容。", "Because of the nature of AI, different users may receive similar content.", "AIの性質上、異なるユーザーに類似した内容が生成される場合があります。"],
    ["重要说明：", "Important:", "重要："],
    ["四、使用规范", "4. Acceptable Use", "4. 利用上のルール"],
    ["用户不得利用本服务从事以下行为：", "Users must not use the Service to:", "ユーザーは本サービスを次の目的で利用してはいけません："],
    ["1. 违反法律法规或社会公序良俗", "1. Violate laws, regulations, or public order", "1. 法令または公序良俗に違反する行為"],
    ["2. 生成或传播违法、政治敏感信息", "2. Generate or distribute unlawful or politically sensitive information", "2. 違法または政治的にセンシティブな情報を生成・拡散する行為"],
    ["3. 生成暴力、色情、仇恨、歧视等内容", "3. Generate violent, sexual, hateful, or discriminatory content", "3. 暴力、性的、憎悪、差別的な内容を生成する行為"],
    ["4. 侵犯他人隐私、名誉或知识产权", "4. Infringe privacy, reputation, or intellectual property", "4. 他者のプライバシー、名誉、知的財産権を侵害する行為"],
    ["5. 利用本服务进行诈骗、攻击或其他非法行为", "5. Commit fraud, attacks, or other unlawful acts", "5. 詐欺、攻撃、その他の違法行為に利用すること"],
    ["五、第三方服务说明", "5. Third-Party Services", "5. 第三者サービス"],
    ["本服务基于第三方人工智能服务提供支持（如 DeepSeek API）。用户理解并同意：", "The Service relies on third-party AI services such as the DeepSeek API. Users understand and agree that:", "本サービスはDeepSeek APIなどの第三者AIサービスを利用しています。ユーザーは次の事項を理解し、同意するものとします："],
    ["1. 部分数据可能会被发送至第三方用于生成结果", "1. Some data may be sent to third parties to generate results", "1. 結果を生成するため、一部のデータが第三者へ送信される場合があります"],
    ["2. 第三方服务可能具有独立的协议与隐私政策", "2. Third-party services may have separate terms and privacy policies", "2. 第三者サービスには独自の規約とプライバシーポリシーが適用される場合があります"],
    ["3. 本服务不对第三方服务的稳定性或结果负责", "3. We are not responsible for the stability or results of third-party services", "3. 第三者サービスの安定性や結果について、本サービスは責任を負いません"],
    ["六、数据与隐私", "6. Data and Privacy", "6. データとプライバシー"],
    ["1. 我们可能收集用户输入内容及基础设备信息，用于服务优化与安全保障。", "1. We may collect user input and basic device information to improve and secure the Service.", "1. サービス改善と安全確保のため、ユーザー入力と基本的な端末情報を収集する場合があります。"],
    ["2. 数据可能存储于云端服务器。", "2. Data may be stored on cloud servers.", "2. データはクラウドサーバーに保存される場合があります。"],
    ["3. 在技术处理（如脱敏）后，数据可能用于改进服务。", "3. After technical processing such as de-identification, data may be used to improve the Service.", "3. 匿名化などの技術処理後、データがサービス改善に利用される場合があります。"],
    ["七、知识产权", "7. Intellectual Property", "7. 知的財産権"],
    ["1. 本服务的系统、界面、代码等均受法律保护。", "1. The Service's systems, interface, and code are legally protected.", "1. 本サービスのシステム、画面、コードなどは法的に保護されています。"],
    ["2. 用户保留其输入内容的权利。", "2. Users retain rights in their input.", "2. ユーザーは入力内容に関する権利を保持します。"],
    ["3. 在法律允许范围内，用户可使用生成内容。", "3. Users may use generated content where permitted by law.", "3. ユーザーは法令で認められる範囲で生成内容を利用できます。"],
    ["八、免责声明", "8. Disclaimer", "8. 免責事項"],
    ["1. 本服务按“现状”提供，不保证无错误或不中断。", "1. The Service is provided “as is,” without guarantees that it will be error-free or uninterrupted.", "1. 本サービスは現状有姿で提供され、無エラーまたは中断のない動作を保証しません。"],
    ["2. 对因使用本服务产生的任何损失（包括数据丢失、业务中断等），本服务不承担责任。", "2. We are not liable for losses arising from use of the Service, including data loss or business interruption.", "2. データ消失や業務中断など、本サービスの利用により生じた損失について責任を負いません。"],
    ["九、服务变更与终止", "9. Changes and Termination", "9. サービスの変更と終了"],
    ["我们有权根据需要调整、中断或终止部分或全部服务。", "We may adjust, suspend, or terminate some or all of the Service as needed.", "必要に応じて、本サービスの一部または全部を変更、中断、終了する場合があります。"],
    ["十、协议更新", "10. Updates to These Terms", "10. 規約の更新"],
    ["本协议可能不定期更新，更新后继续使用即视为同意最新版本。", "These Terms may be updated from time to time. Continued use after an update means you accept the latest version.", "本規約は随時更新される場合があります。更新後も利用を継続した場合、最新版に同意したものとみなされます。"],
    ["十一、付费与服务说明", "11. Payments and Paid Services", "11. 支払いと有料サービス"],
    ["1. 本服务部分功能可能为付费功能，用户可自愿选择是否购买。", "1. Some features may be paid; users may choose whether to purchase them.", "1. 一部機能は有料の場合があり、購入するかどうかはユーザーが選択できます。"],
    ["2. 所有费用以页面展示为准，一经支付，除法律规定外一般不支持退款。", "2. Fees are as displayed on the page. Payments are generally non-refundable except where required by law.", "2. 料金は画面表示に従います。法令で定められる場合を除き、支払い後の返金には原則対応しません。"],
    ["3. 我们有权根据实际情况调整收费标准或服务内容。", "3. We may adjust pricing or service content as circumstances require.", "3. 状況に応じて、料金またはサービス内容を変更する場合があります。"],
    ["十二、违约与处理", "12. Violations and Enforcement", "12. 違反と対応"],
    ["如用户违反本协议或相关法律法规，我们有权：", "If a user violates these Terms or applicable law, we may:", "ユーザーが本規約または関連法令に違反した場合、当サービスは次の対応を行うことがあります："],
    ["1. 限制或终止用户使用本服务", "1. Restrict or terminate access to the Service", "1. 本サービスの利用を制限または終了する"],
    ["2. 删除相关内容", "2. Delete related content", "2. 関連する内容を削除する"],
    ["3. 保留追究法律责任的权利", "3. Reserve the right to pursue legal remedies", "3. 法的責任を追及する権利を留保する"],
    ["十三、法律适用与争议解决", "13. Governing Law and Disputes", "13. 準拠法と紛争解決"],
    ["本协议适用中华人民共和国法律。因本协议引起的争议，双方应协商解决；协商不成的，提交有管辖权的人民法院处理。", "These Terms are governed by the laws of the People's Republic of China. The parties should first seek to resolve disputes through consultation; unresolved disputes shall be submitted to a court with jurisdiction.", "本規約には中華人民共和国の法律が適用されます。本規約に関する紛争は当事者間で協議し、解決できない場合は管轄権を有する人民法院へ提出するものとします。"],
    ["十四、联系我们", "14. Contact Us", "14. お問い合わせ"],
    ["如您对本协议有任何疑问，可通过以下方式联系我们：", "If you have questions about these Terms, contact us at:", "本規約に関するご質問は、次の連絡先までお問い合わせください："],
    ["若您不同意本协议，请立即停止使用本服务。", "If you do not agree to these Terms, stop using the Service immediately.", "本規約に同意しない場合は、直ちにサービスの利用を中止してください。"],

    // OAuth callback.
    ["登录处理中…", "Signing you in…", "ログイン処理中…"],

    // Symbolic AI development shell (user-visible when opened directly).
    ["Symbolic AI · 可解释推理机", "Symbolic AI · Explainable Reasoning Engine", "Symbolic AI · 説明可能な推論エンジン"],
    ["输入 → 语言解析 → 知识图谱 → 推理引擎 → 学习 → 答案（无 LLM）", "Input → Language Parsing → Knowledge Graph → Reasoning Engine → Learning → Answer (No LLM)", "入力 → 言語解析 → 知識グラフ → 推論エンジン → 学習 → 回答（LLMなし）"],
    ["待实现（后续阶段）", "Planned for a later stage", "今後の段階で実装予定"],
    ["Stage 1 · 脚手架", "Stage 1 · Scaffold", "Stage 1 · スキャフォールド"],
    ["① 对话 / 输入", "① Chat / Input", "① 対話 / 入力"],
    ["② 推理过程", "② Reasoning Process", "② 推論過程"],
    ["③ 知识图谱", "③ Knowledge Graph", "③ 知識グラフ"],
    ["④ 知识编辑器", "④ Knowledge Editor", "④ 知識エディター"],
  ];

  const additionalCatalog = global.SiteI18nAdditionalCatalog || {};
  const catalog = new Map(
    rows.map(([source, en, ja]) => [source, Object.freeze({
      zh: source,
      en,
      ja,
      ...(additionalCatalog[source] || {}),
    })]),
  );

  const patternRows = [
    [/^今日剩余\s*(\d+)\s*次$/u, (_, count) => ({ "zh-Hant": `今日剩餘 ${count} 次`, en: `${count} uses left today`, ja: `本日あと${count}回`, ko: `오늘 ${count}회 남음`, es: `${count} usos disponibles hoy` })],
    [/^已有上下文\s*·\s*(\d+)\s*轮对话，继续生成将延续之前的讨论$/u, (_, count) => ({ "zh-Hant": `已有上下文 · ${count} 輪對話，繼續生成將延續之前的討論`, en: `Context active · ${count} turns; the next result continues the discussion`, ja: `文脈あり · ${count}ターン。次の生成もこれまでの議論を引き継ぎます`, ko: `컨텍스트 활성화 · ${count}회 대화; 다음 생성에서도 이전 논의를 이어갑니다`, es: `Contexto activo · ${count} turnos; la siguiente generación continuará la conversación` })],
    [/^第\s*(\d+)\s*轮$/u, (_, count) => ({ "zh-Hant": `第 ${count} 輪`, en: `Round ${count}`, ja: `${count}ターン目`, ko: `${count}번째`, es: `Ronda ${count}` })],
    [/^共\s*(\d+)\s*条$/u, (_, count) => ({ "zh-Hant": `共 ${count} 條`, en: `${count} items`, ja: `${count}件`, ko: `총 ${count}개`, es: `${count} elementos` })],
    [/^(\d+)\s*场\s*·\s*横向滑动查看更多$/u, (_, count) => ({ "zh-Hant": `${count} 場 · 橫向滑動查看更多`, en: `${count} ${Number(count) === 1 ? "event" : "events"} · Swipe sideways for more`, ja: `${count}件 · 横にスワイプして続きを表示`, ko: `${count}개 · 옆으로 밀어 더 보기`, es: `${count} ${Number(count) === 1 ? "evento" : "eventos"} · Desliza para ver más` })],
    [/^相关兽聚活动，共\s*(\d+)\s*场$/u, (_, count) => ({ "zh-Hant": `相關獸聚活動，共 ${count} 場`, en: `${count} related furry ${Number(count) === 1 ? "event" : "events"}`, ja: `関連するファーリーイベント ${count}件`, ko: `관련 퍼리 행사 ${count}개`, es: `${count} ${Number(count) === 1 ? "evento furry relacionado" : "eventos furry relacionados"}` })],
    [/^(\d+)月(\d+)日(?:–(\d+)月(\d+)日)?$/u, (_, startMonth, startDay, endMonth, endDay) => ({
      en: endMonth ? `${startMonth}/${startDay}–${endMonth}/${endDay}` : `${startMonth}/${startDay}`,
      ja: endMonth ? `${startMonth}月${startDay}日–${endMonth}月${endDay}日` : `${startMonth}月${startDay}日`,
      ko: endMonth ? `${startMonth}월 ${startDay}일–${endMonth}월 ${endDay}일` : `${startMonth}월 ${startDay}일`,
      es: endMonth ? `${startDay}/${startMonth}–${endDay}/${endMonth}` : `${startDay}/${startMonth}`,
      "zh-Hant": endMonth ? `${startMonth}月${startDay}日–${endMonth}月${endDay}日` : `${startMonth}月${startDay}日`,
    })],
    [/^(.+)活动封面$/u, (_, name) => ({ "zh-Hant": `${name}活動封面`, en: `${name} event cover`, ja: `${name} イベント画像`, ko: `${name} 행사 표지`, es: `Portada del evento ${name}` })],
    [/^删除对话：(.+)$/u, (_, title) => ({ "zh-Hant": `刪除對話：${title}`, en: `Delete chat: ${title}`, ja: `チャットを削除：${title}`, ko: `대화 삭제: ${title}`, es: `Eliminar chat: ${title}` })],
    [/^(\d+)\s*分钟前$/u, (_, count) => ({ "zh-Hant": `${count} 分鐘前`, en: `${count} min ago`, ja: `${count}分前`, ko: `${count}분 전`, es: `Hace ${count} min` })],
    [/^(\d+)\s*小时前$/u, (_, count) => ({ "zh-Hant": `${count} 小時前`, en: `${count} hr ago`, ja: `${count}時間前`, ko: `${count}시간 전`, es: `Hace ${count} h` })],
    [/^今天$/u, () => ({ "zh-Hant": "今天", en: "Today", ja: "今日", ko: "오늘", es: "Hoy" })],
    [/^确定删除“(.+)”吗？删除后无法恢复。$/u, (_, value) => ({ "zh-Hant": `確定刪除「${value}」嗎？刪除後無法復原。`, en: `Delete “${value}”? This cannot be undone.`, ja: `「${value}」を削除しますか？元に戻せません。`, ko: `“${value}”을(를) 삭제할까요? 삭제 후에는 복구할 수 없습니다.`, es: `¿Eliminar “${value}”? Esta acción no se puede deshacer.` })],
    [/^请求失败（(.+)），请稍后重试$/u, (_, status) => ({ "zh-Hant": `請求失敗（${status}），請稍後重試`, en: `Request failed (${status}). Please try again later.`, ja: `リクエストに失敗しました（${status}）。後でもう一度お試しください。`, ko: `요청에 실패했습니다(${status}). 나중에 다시 시도해 주세요.`, es: `La solicitud falló (${status}). Inténtalo de nuevo más tarde.` })],
  ];

  let currentLanguage = detectLanguage();
  let observer = null;
  let nativeAlert = null;
  let nativeConfirm = null;
  const textState = new WeakMap();
  const attributeState = new WeakMap();
  const TRANSLATABLE_ATTRIBUTES = ["placeholder", "aria-label", "title", "alt", "data-tooltip"];
  const IGNORE_SELECTOR = [
    "script",
    "style",
    "code",
    "pre",
    "template",
    "[data-site-i18n-ignore]",
    "#chatInner",
    "#chatList",
    "#thanksList",
    "#terminal",
    "#boot",
  ].join(",");

  function normalizeLanguage(value) {
    const language = String(value || "").trim().toLowerCase();
    if (["zh-hant", "zh-tw", "zh-hk", "zh-mo"].some((code) => language === code || language.startsWith(`${code}-`))) return "zh-Hant";
    if (language === "zh" || language.startsWith("zh-")) return "zh";
    if (language === "ja" || language.startsWith("ja-")) return "ja";
    if (language === "en" || language.startsWith("en-")) return "en";
    if (language === "ko" || language.startsWith("ko-")) return "ko";
    if (language === "es" || language.startsWith("es-")) return "es";
    return null;
  }

  function readStoredLanguage() {
    try {
      return normalizeLanguage(global.localStorage?.getItem(STORAGE_KEY));
    } catch (_) {
      return null;
    }
  }

  function detectBrowserLanguage() {
    const candidates = [];
    try {
      if (Array.isArray(global.navigator?.languages)) candidates.push(...global.navigator.languages);
      if (global.navigator?.language) candidates.push(global.navigator.language);
      if (global.navigator?.userLanguage) candidates.push(global.navigator.userLanguage);
    } catch (_) {}

    for (const candidate of candidates) {
      const normalized = normalizeLanguage(candidate);
      if (normalized) return normalized;
    }
    return "en";
  }

  function detectLanguage() {
    return readStoredLanguage() || detectBrowserLanguage();
  }

  function writeStoredLanguage(language) {
    try {
      global.localStorage?.setItem(STORAGE_KEY, language);
    } catch (_) {}
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/gu, " ").trim();
  }

  function translate(source, language = currentLanguage) {
    const originalSource = String(source || "");
    const normalizedSource = normalizeText(source);
    const normalizedLanguage = normalizeLanguage(language) || "en";
    if (!normalizedSource || normalizedLanguage === "zh") return originalSource;

    const exact = catalog.get(normalizedSource);
    if (exact?.[normalizedLanguage]) return exact[normalizedLanguage];
    if (exact?.en) return exact.en;

    for (const [pattern, createTranslations] of patternRows) {
      const match = normalizedSource.match(pattern);
      if (!match) continue;
      const translated = createTranslations(...match);
      return translated[normalizedLanguage] || translated.en || normalizedSource;
    }
    return originalSource;
  }

  function isIgnored(node) {
    const element = node.nodeType === 1 ? node : node.parentElement;
    return !element || Boolean(element.closest(IGNORE_SELECTOR));
  }

  function preserveOuterWhitespace(original, translated) {
    const leading = String(original).match(/^\s*/u)?.[0] || "";
    const trailing = String(original).match(/\s*$/u)?.[0] || "";
    return `${leading}${translated}${trailing}`;
  }

  function translateTextNode(node) {
    if (!node || node.nodeType !== 3 || isIgnored(node)) return;
    const value = node.nodeValue || "";
    if (!normalizeText(value)) return;

    const previous = textState.get(node);
    const isCurrentRender = Boolean(previous && value === previous.rendered);
    const source = isCurrentRender ? previous.source : normalizeText(value);
    const renderedText = translate(source);
    const rendered = renderedText === source && (!isCurrentRender || value === source)
      ? value
      : preserveOuterWhitespace(value, renderedText);
    textState.set(node, { source, rendered });
    if (value !== rendered) node.nodeValue = rendered;
  }

  function translateAttribute(element, name) {
    const value = element.getAttribute(name);
    if (!value || isIgnored(element)) return;

    let states = attributeState.get(element);
    if (!states) {
      states = new Map();
      attributeState.set(element, states);
    }
    const previous = states.get(name);
    const source = previous && value === previous.rendered ? previous.source : normalizeText(value);
    const rendered = translate(source);
    states.set(name, { source, rendered });
    if (value !== rendered) element.setAttribute(name, rendered);
  }

  function apply(root = global.document) {
    if (!root || !global.document) return;

    if (root.nodeType === 3) {
      translateTextNode(root);
      return;
    }

    if (root.nodeType === 1) {
      for (const name of TRANSLATABLE_ATTRIBUTES) translateAttribute(root, name);
    }

    const walker = global.document.createTreeWalker(root, global.NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) translateTextNode(walker.currentNode);

    if (root.querySelectorAll) {
      const selector = TRANSLATABLE_ATTRIBUTES.map((name) => `[${name}]`).join(",");
      root.querySelectorAll(selector).forEach((element) => {
        for (const name of TRANSLATABLE_ATTRIBUTES) {
          if (element.hasAttribute(name)) translateAttribute(element, name);
        }
      });
    }
  }

  function updateSwitcherState() {
    global.document?.querySelectorAll("#langSwitcher [data-lang]").forEach((button) => {
      const active = normalizeLanguage(button.dataset.lang) === currentLanguage;
      button.classList.toggle("active", active);
      const state = active ? "true" : "false";
      if (button.getAttribute("role") === "menuitemradio") {
        button.setAttribute("aria-checked", state);
        button.removeAttribute("aria-pressed");
      } else if (button.getAttribute("aria-pressed") !== state) {
        button.setAttribute("aria-pressed", state);
      }
    });

    const details = LANGUAGE_DETAILS[currentLanguage];
    const currentLabel = global.document?.querySelector("#languageMenuToggle [data-language-current-label]");
    const currentFlag = global.document?.querySelector("#languageMenuToggle [data-language-current-flag]");
    if (currentLabel && details && currentLabel.textContent !== details.label) {
      currentLabel.textContent = details.label;
    }
    if (currentFlag && details) {
      if (currentFlag.getAttribute("src") !== details.flag) currentFlag.src = details.flag;
      if (currentFlag.alt !== "") currentFlag.alt = "";
    }
  }

  function setLanguage(value, options = {}) {
    const language = normalizeLanguage(value);
    if (!language) return currentLanguage;
    currentLanguage = language;
    if (options.persist !== false) writeStoredLanguage(language);
    if (global.document?.documentElement) global.document.documentElement.lang = HTML_LANG[language];
    apply(global.document);
    updateSwitcherState();
    global.dispatchEvent?.(new global.CustomEvent("site-language-change", { detail: { language } }));
    return language;
  }

  function bindSwitcher() {
    global.document?.querySelectorAll("#langSwitcher [data-lang]").forEach((button) => {
      if (button.dataset.siteI18nBound === "1") return;
      button.dataset.siteI18nBound = "1";
      button.addEventListener("click", () => setLanguage(button.dataset.lang), true);
    });
    bindDropdown();
    updateSwitcherState();
  }

  function bindDropdown() {
    const switcher = global.document?.getElementById("langSwitcher");
    const toggle = global.document?.getElementById("languageMenuToggle");
    const menu = global.document?.getElementById("languageMenu");
    if (!switcher || !toggle || !menu || switcher.dataset.siteDropdownBound === "1") return;
    switcher.dataset.siteDropdownBound = "1";

    const items = () => Array.from(menu.querySelectorAll('[role="menuitemradio"][data-lang]'));
    const close = (restoreFocus = false) => {
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      if (restoreFocus) toggle.focus();
    };
    const open = (focusPosition = "first") => {
      menu.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      const choices = items();
      const target = focusPosition === "last" ? choices.at(-1) : choices[0];
      target?.focus();
    };

    toggle.addEventListener("click", () => {
      if (menu.hidden) open();
      else close();
    });
    toggle.addEventListener("keydown", (event) => {
      if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      open(event.key === "ArrowUp" ? "last" : "first");
    });
    menu.addEventListener("keydown", (event) => {
      const choices = items();
      const index = choices.indexOf(global.document.activeElement);
      if (event.key === "Tab") {
        close();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
        return;
      }
      let nextIndex = null;
      if (event.key === "ArrowDown") nextIndex = (index + 1) % choices.length;
      if (event.key === "ArrowUp") nextIndex = (index - 1 + choices.length) % choices.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = choices.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      choices[nextIndex]?.focus();
    });
    menu.addEventListener("click", (event) => {
      if (!event.target.closest("[data-lang]")) return;
      close(true);
    });
    global.document.addEventListener("pointerdown", (event) => {
      if (!switcher.contains(event.target)) close();
    });
  }

  function startObserver() {
    if (observer || !global.MutationObserver || !global.document?.documentElement) return;
    observer = new global.MutationObserver((mutations) => {
      let shouldBindSwitcher = false;
      for (const mutation of mutations) {
        if (isIgnored(mutation.target)) continue;
        if (mutation.type === "characterData") translateTextNode(mutation.target);
        if (mutation.type === "attributes") translateAttribute(mutation.target, mutation.attributeName);
        if (mutation.type === "childList") {
          mutation.addedNodes.forEach((node) => apply(node));
          shouldBindSwitcher = true;
        }
      }
      if (shouldBindSwitcher) bindSwitcher();
    });
    observer.observe(global.document.documentElement, {
      attributes: true,
      attributeFilter: TRANSLATABLE_ATTRIBUTES,
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  function wrapNativeDialogs() {
    if (typeof global.alert === "function" && !nativeAlert) {
      nativeAlert = global.alert.bind(global);
      global.alert = (message) => nativeAlert(translate(message));
    }
    if (typeof global.confirm === "function" && !nativeConfirm) {
      nativeConfirm = global.confirm.bind(global);
      global.confirm = (message) => nativeConfirm(translate(message));
    }
  }

  const api = Object.freeze({
    supportedLanguages: SUPPORTED_LANGUAGES,
    getLanguage: () => currentLanguage,
    setLanguage,
    detectLanguage,
    normalizeLanguage,
    translate,
    apply,
  });

  global.SiteI18n = api;
  if (global.document?.documentElement) global.document.documentElement.lang = HTML_LANG[currentLanguage];
  wrapNativeDialogs();

  global.addEventListener?.("storage", (event) => {
    if (event.key === STORAGE_KEY && event.newValue) setLanguage(event.newValue, { persist: false });
  });

  const onReady = () => {
    apply(global.document);
    bindSwitcher();
    startObserver();
  };
  if (global.document?.readyState === "loading") {
    global.document.addEventListener("DOMContentLoaded", onReady, { once: true });
  } else {
    onReady();
  }
})(window);
