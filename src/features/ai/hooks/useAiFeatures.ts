import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AiSettings } from "@/shared/types";
import { TRANSFORM_OPTIONS, MERMAID_GENERATE_PROMPT } from "@/shared/lib/constants";

async function callAI(
  settings: AiSettings,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  return invoke<string>("ai_chat", {
    req: {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      apiFormat: settings.apiFormat,
      azureApiVersion: settings.azureApiVersion ?? "",
      systemPrompt,
      userMessage,
    },
  });
}

interface UseAiFeaturesParams {
  aiSettings: AiSettings;
}

export function useAiFeatures({ aiSettings }: UseAiFeaturesParams) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateMermaid = useCallback(
    async (description: string): Promise<string> => {
      setGenerating(true);
      setError(null);
      try {
        const result = await callAI(aiSettings, MERMAID_GENERATE_PROMPT, description);
        return result.replace(/```mermaid\n?/g, "").replace(/```\n?/g, "").trim();
      } catch (e: any) {
        setError(e.message ?? String(e));
        throw e;
      } finally {
        setGenerating(false);
      }
    },
    [aiSettings]
  );

  const transformText = useCallback(
    async (text: string, transformId: string): Promise<string> => {
      const option = TRANSFORM_OPTIONS.find((o) => o.id === transformId);
      if (!option) throw new Error(`Unknown transform: ${transformId}`);

      setGenerating(true);
      setError(null);
      try {
        return await callAI(aiSettings, option.prompt, text);
      } catch (e: any) {
        setError(e.message ?? String(e));
        throw e;
      } finally {
        setGenerating(false);
      }
    },
    [aiSettings]
  );

  const generateWithInstruction = useCallback(
    async (instruction: string, content: string): Promise<string> => {
      setGenerating(true);
      setError(null);
      try {
        return await callAI(aiSettings, instruction, content);
      } catch (e: any) {
        setError(e.message ?? String(e));
        throw e;
      } finally {
        setGenerating(false);
      }
    },
    [aiSettings]
  );

  return {
    generating,
    error,
    generateMermaid,
    transformText,
    generateWithInstruction,
  } as const;
}
