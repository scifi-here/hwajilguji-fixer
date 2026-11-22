export const MAX_INPUT_PIXELS = 8_000_000;
export const MAX_OUTPUT_PIXELS = 32_000_000;

export class InputTooLargeError extends Error {
	override readonly name = "InputTooLargeError";

	constructor(readonly pixels: number) {
		super(
			`이미지가 ${pixels.toLocaleString("ko-KR")} 픽셀입니다. 최대 ${MAX_INPUT_PIXELS.toLocaleString("ko-KR")} 픽셀까지 처리합니다.`,
		);
	}
}
