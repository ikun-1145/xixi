import { AI_DETECTION_UNAVAILABLE } from "./constants.js";

export async function detectAIContent() {
  return {
    status: AI_DETECTION_UNAVAILABLE.status,
    methods: [...AI_DETECTION_UNAVAILABLE.methods],
    limitations: [...AI_DETECTION_UNAVAILABLE.limitations],
  };
}

