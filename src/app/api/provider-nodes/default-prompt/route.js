import { NextResponse } from "next/server";
import { readPromptFile } from "open-sse/providers/defaultPrompts.js";

export const dynamic = "force-dynamic";

// GET /api/provider-nodes/default-prompt - Read the built-in prompt file so the
// node editors can show (and let the user start from) the default override.
export async function GET() {
  try {
    const { path, exists, prompt } = readPromptFile();
    return NextResponse.json({ path, exists, prompt, length: prompt.length });
  } catch (error) {
    console.log("Error reading default prompt file:", error);
    return NextResponse.json({ error: "Failed to read the default prompt file" }, { status: 500 });
  }
}
