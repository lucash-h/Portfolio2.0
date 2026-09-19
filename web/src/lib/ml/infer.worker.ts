/**
 * Inference worker (P2-D).
 *
 * Standard Vite module worker: the board/UI code does
 * `new Worker(new URL('./infer.worker.ts', import.meta.url), { type: 'module' })`
 * and posts `InferRequestMessage`s (mlTypes.ts), receiving `InferResponseMessage`s
 * back. Keeping inference off the main thread means a slow/blocked model never
 * freezes the board.
 *
 * This file only adapts the worker message protocol to `session.ts`'s
 * `chooseMove`; it holds no logic of its own beyond that.
 */

import { chooseMove, DEFAULT_MODEL_BASE_URL, type SessionDeps } from './session';
import type { InferRequestMessage, InferResponseMessage } from './mlTypes';

self.onmessage = async (event: MessageEvent<InferRequestMessage>): Promise<void> => {
	const message = event.data;
	if (message.type !== 'infer') return;

	const deps: SessionDeps = { baseUrl: message.baseUrl ?? DEFAULT_MODEL_BASE_URL };

	const result = await chooseMove(
		message.checkpoint,
		message.state,
		message.legalColumns,
		message.options,
		deps
	);

	const response: InferResponseMessage = {
		type: 'infer-result',
		id: message.id,
		result
	};

	self.postMessage(response);
};

export {};
