/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { createClient } from "@supabase/supabase-js";

type ParsedTask = { task: string };
type Profile = { id: string; full_name: string | null; team_role: string | null };
type TelegramUpdate = {
	update_id: number;
	message?: {
		chat?: { id?: number };
		text?: string;
	};
	callback_query?: {
		id?: string;
		data?: string;
		message?: {
			chat?: { id?: number };
		};
	};
};
type TelegramApiResponse<T> = {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
};

const UUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TELEGRAM_OFFSET_KEY = "telegram_polling_offset";
const TELEGRAM_GET_BOARDS_BUTTON = "boards";

const ROLE_KEYWORDS: Array<{ keywords: string[]; roles: string[] }> = [
	{ keywords: ["api", "backend", "server", "db", "database"], roles: ["backend"] },
	{ keywords: ["ui", "frontend", "design", "ux", "layout"], roles: ["frontend", "designer"] },
	{ keywords: ["test", "qa", "testing", "провер"], roles: ["qa", "tester"] },
	{ keywords: ["deploy", "release", "infra", "devops", "ci", "cd"], roles: ["devops"] },
	{ keywords: ["plan", "spec", "аналит", "требован"], roles: ["manager", "analyst"] },
];

function isUuid(value: string): boolean {
	return UUID_REGEX.test(value);
}

function normalizeRole(role: string | null | undefined): string {
	return (role ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function inferTargetRoles(taskText: string): string[] {
	const normalizedTask = taskText.toLowerCase();
	const result = new Set<string>();

	for (const mapping of ROLE_KEYWORDS) {
		if (mapping.keywords.some((keyword) => normalizedTask.includes(keyword))) {
			for (const role of mapping.roles) {
				result.add(normalizeRole(role));
			}
		}
	}

	return [...result];
}

function roleMatches(profileRole: string | null, targetRole: string): boolean {
	const normalizedProfileRole = normalizeRole(profileRole);
	return (
		normalizedProfileRole === targetRole ||
		normalizedProfileRole.includes(targetRole) ||
		targetRole.includes(normalizedProfileRole)
	);
}

function pickAssignee(taskText: string, candidates: Profile[], fallbackIndex: number): Profile {
	const targetRoles = inferTargetRoles(taskText);

	if (targetRoles.length > 0) {
		const matched = candidates.find((profile) =>
			targetRoles.some((targetRole) => roleMatches(profile.team_role, targetRole)),
		);
		if (matched) {
			return matched;
		}
	}

	return candidates[fallbackIndex % candidates.length];
}

async function callTelegramApi<T>(
	botToken: string,
	method: string,
	payload?: Record<string, unknown>,
): Promise<TelegramApiResponse<T>> {
	const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload ?? {}),
	});

	let responseBody: TelegramApiResponse<T>;
	try {
		responseBody = await response.json<TelegramApiResponse<T>>();
	} catch {
		throw new Error(`Telegram ${method} returned non-JSON response`);
	}

	if (!response.ok || !responseBody.ok) {
		const details = responseBody.description ?? `HTTP ${response.status}`;
		throw new Error(`Telegram ${method} failed: ${details}`);
	}

	return responseBody;
}

function getTelegramKeyboard(): { keyboard: Array<Array<{ text: string }>>; resize_keyboard: boolean } {
	return {
		keyboard: [[{ text: TELEGRAM_GET_BOARDS_BUTTON }]],
		resize_keyboard: true,
	};
}

async function loadBoards(
	env: Env & { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string },
): Promise<{ boards: Array<{ id: string; name: string }>; error: string | null }> {
	const supabaseUrl = env.SUPABASE_URL;
	const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
	if (!supabaseUrl || !supabaseServiceRoleKey) {
		return {
			boards: [],
			error: "Не настроено подключение к Supabase (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).",
		};
	}

	const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
		auth: { persistSession: false },
	});
	const { data: boards, error } = await supabase
		.from("boards")
		.select("id, name")
		.order("created_at", { ascending: true });
	if (error) {
		console.error("Failed to fetch boards from Supabase:", error);
		return {
			boards: [],
			error: "Не получилось получить доски из базы данных.",
		};
	}

	return {
		boards: (boards ?? []) as Array<{ id: string; name: string }>,
		error: null,
	};
}

function getBoardsInlineKeyboard(
	boards: Array<{ id: string; name: string }>,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
	return {
		inline_keyboard: boards.map((board) => [
			{ text: board.name, callback_data: `board:${board.id}` },
		]),
	};
}

async function listBoardTasksMessage(
	env: Env & { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string },
	boardId: string,
): Promise<string> {
	const supabaseUrl = env.SUPABASE_URL;
	const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
	if (!supabaseUrl || !supabaseServiceRoleKey) {
		return "Не настроено подключение к Supabase (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).";
	}

	const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
		auth: { persistSession: false },
	});
	const { data: tasks, error } = await supabase
		.from("tasks")
		.select("title, status")
		.eq("board_id", boardId)
		.order("created_at", { ascending: true });
	if (error) {
		console.error("Failed to fetch tasks from Supabase:", error);
		return "Не получилось получить задачи для выбранной доски.";
	}

	if (!tasks || tasks.length === 0) {
		return "На выбранной доске пока нет задач.";
	}

	const lines = tasks.map(
		(task, index) => `${index + 1}. ${task.title}${task.status ? ` [${task.status}]` : ""}`,
	);
	return `Задачи на доске:\n${lines.join("\n")}`;
}

async function sendTelegramMessage(
	botToken: string,
	chatId: number,
	text: string,
	replyMarkup?: Record<string, unknown>,
): Promise<void> {
	await callTelegramApi(botToken, "sendMessage", {
		chat_id: chatId,
		text,
		reply_markup: replyMarkup,
	});
}

async function respondToTelegramUpdate(
	botToken: string,
	update: TelegramUpdate,
	env: Env & { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string },
): Promise<void> {
	const callbackQueryId = update.callback_query?.id;
	const callbackChatId = update.callback_query?.message?.chat?.id;
	const callbackData = update.callback_query?.data?.trim();
	if (typeof callbackChatId === "number" && callbackData?.startsWith("board:")) {
		const boardId = callbackData.slice("board:".length);
		const tasksMessage = await listBoardTasksMessage(env, boardId);
		await sendTelegramMessage(botToken, callbackChatId, tasksMessage, getTelegramKeyboard());
		if (callbackQueryId) {
			await callTelegramApi(botToken, "answerCallbackQuery", {
				callback_query_id: callbackQueryId,
			});
		}
		return;
	}

	const chatId = update.message?.chat?.id;
	if (typeof chatId !== "number") {
		return;
	}

	const normalizedText = update.message?.text?.trim();
	const wantsBoards =
		normalizedText === TELEGRAM_GET_BOARDS_BUTTON || normalizedText === "/boards";
	if (!wantsBoards) {
		await sendTelegramMessage(
			botToken,
			chatId,
			"Нажмите кнопку boards, чтобы получить список досок.",
			getTelegramKeyboard(),
		);
		return;
	}

	const { boards, error } = await loadBoards(env);
	if (error) {
		await sendTelegramMessage(botToken, chatId, error, getTelegramKeyboard());
		return;
	}
	if (boards.length === 0) {
		await sendTelegramMessage(botToken, chatId, "В базе пока нет досок.", getTelegramKeyboard());
		return;
	}

	await sendTelegramMessage(
		botToken,
		chatId,
		"Выберите доску:",
		getBoardsInlineKeyboard(boards),
	);
}

async function runTelegramPolling(
	env: Env & {
		TELEGRAM_BOT_TOKEN?: string;
		TELEGRAM_STATE?: KVNamespace;
		SUPABASE_URL?: string;
		SUPABASE_SERVICE_ROLE_KEY?: string;
	},
): Promise<void> {
	const botToken = env.TELEGRAM_BOT_TOKEN;
	const stateStore = env.TELEGRAM_STATE;
	if (!botToken) {
		console.warn("TELEGRAM_BOT_TOKEN is not set; skipping Telegram polling");
		return;
	}
	if (!stateStore) {
		console.warn("TELEGRAM_STATE KV binding is not set; skipping Telegram polling");
		return;
	}

	const offsetValue = await stateStore.get(TELEGRAM_OFFSET_KEY);
	const currentOffset = Number.parseInt(offsetValue ?? "0", 10);
	const safeOffset = Number.isFinite(currentOffset) ? currentOffset : 0;

	const updatesResponse = await callTelegramApi<TelegramUpdate[]>(botToken, "getUpdates", {
		offset: safeOffset,
		allowed_updates: ["message", "callback_query"],
		limit: 100,
		timeout: 0,
	});
	const updates = updatesResponse.result ?? [];

	let nextOffset = safeOffset;
	for (const update of updates) {
		const updateNextOffset = update.update_id + 1;
		try {
			await respondToTelegramUpdate(botToken, update, env);
			nextOffset = updateNextOffset;
		} catch (error) {
			console.error("Failed to send Telegram reply:", error);
			break;
		}
	}

	if (nextOffset !== safeOffset) {
		await stateStore.put(TELEGRAM_OFFSET_KEY, String(nextOffset));
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/test") {
			return new Response("тест пройден");
		}

		if (request.method === "POST" && url.pathname === "/telegram/webhook") {
			const botToken = (env as Env & { TELEGRAM_BOT_TOKEN?: string }).TELEGRAM_BOT_TOKEN;
			if (!botToken) {
				return Response.json({ error: "TELEGRAM_BOT_TOKEN is not set" }, { status: 500 });
			}

			let update: TelegramUpdate;
			try {
				update = await request.json<TelegramUpdate>();
			} catch {
				return Response.json({ ok: true });
			}

			ctx.waitUntil(
				respondToTelegramUpdate(
					botToken,
					update,
					env as Env & { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string },
				).catch((error) => {
					console.error("Failed to send webhook reply:", error);
				}),
			);

			return Response.json({ ok: true });
		}

		if (request.method === "POST" && url.pathname === "/chat") {
			const apiKey = (env as Env & { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY;
			const supabaseUrl = (env as Env & { SUPABASE_URL?: string }).SUPABASE_URL;
			const supabaseServiceRoleKey = (env as Env & { SUPABASE_SERVICE_ROLE_KEY?: string })
				.SUPABASE_SERVICE_ROLE_KEY;
			if (!apiKey) {
				return Response.json(
					{ error: "OPENROUTER_API_KEY is not set" },
					{ status: 500 },
				);
			}
			if (!supabaseUrl || !supabaseServiceRoleKey) {
				return Response.json(
					{ error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set" },
					{ status: 500 },
				);
			}

			let body: { message?: string; board_id?: string };
			try {
				body = await request.json<{ message?: string; board_id?: string }>();
			} catch {
				return Response.json(
					{ error: "Invalid JSON body" },
					{ status: 400 },
				);
			}

			const message = body.message?.trim();
			const boardId = body.board_id?.trim();
			if (!message) {
				return Response.json(
					{ error: "Field 'message' is required" },
					{ status: 400 },
				);
			}
			if (!boardId) {
				return Response.json(
					{ error: "Field 'board_id' is required" },
					{ status: 400 },
				);
			}
			if (!isUuid(boardId)) {
				return Response.json(
					{ error: "Field 'board_id' must be a valid UUID" },
					{ status: 400 },
				);
			}

			const llmResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: "deepseek/deepseek-v4-pro",
					messages: [
						{
							role: "system",
							content:
								'Ты разбиваешь большую задачу на подзадачи. Верни только валидный JSON-массив объектов формата [{"task":"..."}]. Без markdown, без пояснений, без дополнительного текста. От 4 до 10 подзадач. Каждая подзадача должна быть конкретной и выполнимой.',
						},
						{
							role: "user",
							content: message,
						},
					],
				}),
			});

			if (!llmResponse.ok) {
				const errorText = await llmResponse.text();
				return Response.json(
					{
						error: "OpenRouter request failed",
						status: llmResponse.status,
						details: errorText,
					},
					{ status: 502 },
				);
			}

			const data = await llmResponse.json<{
				choices?: Array<{ message?: { content?: string } }>;
			}>();
			const reply = data.choices?.[0]?.message?.content?.trim();

			if (!reply) {
				return Response.json(
					{ error: "Model returned empty response" },
					{ status: 502 },
				);
			}

			let parsedTasks: unknown;
			try {
				parsedTasks = JSON.parse(reply);
			} catch {
				return Response.json(
					{
						error: "Model returned invalid JSON format",
						details: reply,
					},
					{ status: 502 },
				);
			}

			if (!Array.isArray(parsedTasks)) {
				return Response.json(
					{
						error: "Model response must be an array of tasks",
						details: reply,
					},
					{ status: 502 },
				);
			}

			const tasks: ParsedTask[] = [];
			for (const item of parsedTasks) {
				if (
					typeof item !== "object" ||
					item === null ||
					!("task" in item) ||
					typeof item.task !== "string" ||
					!item.task.trim()
				) {
					return Response.json(
						{
							error: "Each task item must be an object with a non-empty string field 'task'",
							details: reply,
						},
						{ status: 502 },
					);
				}

				tasks.push({ task: item.task.trim() });
			}

			const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
				auth: { persistSession: false },
			});

			const { data: profiles, error: profilesError } = await supabase
				.from("profiles")
				.select("id, full_name, team_role");
			if (profilesError) {
				return Response.json(
					{
						error: "Failed to fetch users from Supabase",
						details: profilesError.message,
					},
					{ status: 502 },
				);
			}

			const { data: boardMembers, error: membersError } = await supabase
				.from("board_members")
				.select("user_id")
				.eq("board_id", boardId);
			if (membersError) {
				return Response.json(
					{
						error: "Failed to fetch board members from Supabase",
						details: membersError.message,
					},
					{ status: 502 },
				);
			}

			const allProfiles = (profiles ?? []) as Profile[];
			const memberIds = new Set((boardMembers ?? []).map((member) => member.user_id));
			const candidates =
				memberIds.size > 0
					? allProfiles.filter((profile) => memberIds.has(profile.id))
					: allProfiles;

			if (candidates.length === 0) {
				return Response.json(
					{ error: "No available users for task assignment" },
					{ status: 400 },
				);
			}

			const assignments: Array<{
				task: string;
				assignee: { id: string; full_name: string | null; team_role: string | null };
				task_id: string;
			}> = [];
			let fallbackIndex = 0;

			for (const task of tasks) {
				const assignee = pickAssignee(task.task, candidates, fallbackIndex);
				fallbackIndex += 1;

				const { data: insertedTask, error: insertError } = await supabase
					.from("tasks")
					.insert({
						board_id: boardId,
						title: task.task,
						status: "todo",
						priority: "medium",
						assignee_id: assignee.id,
					})
					.select("id")
					.single();

				if (insertError || !insertedTask) {
					return Response.json(
						{
							error: "Failed to persist task assignment",
							details: insertError?.message ?? "Unknown insert error",
						},
						{ status: 502 },
					);
				}

				assignments.push({
					task: task.task,
					assignee: {
						id: assignee.id,
						full_name: assignee.full_name,
						team_role: assignee.team_role,
					},
					task_id: insertedTask.id,
				});
			}

			return Response.json({ assignments });
		}

		return new Response("Hello World!");
	},
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(
			runTelegramPolling(env as Env & { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_STATE?: KVNamespace }),
		);
	},
} satisfies ExportedHandler<Env>;
