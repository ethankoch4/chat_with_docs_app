// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

import { serve } from "std/server";
// import "https://deno.land/x/xhr@0.2.1/mod.ts";
import { createClient, Session } from "@supabase/supabase-js";
import { Configuration, OpenAIApi } from "openai";
import { v5 } from "uuid";
import axios from "axios";
import cheerio from "cheerio";
import fetch from "node-fetch";

export const supabase = createClient(
  Deno.env.get("NEXT_PUBLIC_SUPABASE_URL"),
  Deno.env.get("NEXT_PUBLIC_SUPABASE_KEY"),
);

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const uuid_namespace = "3b2ef630-3e55-4cfd-bfaa-5bece38181cc";

async function extractTextFromHtml(html: string): Promise<string> {
  const $ = cheerio.load(html);

  async function getTextFromElement(element: CheerioElement): Promise<string> {
    const text = await Promise.all(
      $(element)
        .contents()
        .map(async (_, el) => {
          if (el.type === "text") {
            return $(el).text();
          } else if (el.type === "tag") {
            return await getTextFromElement(el);
          }
          return "";
        })
        .get()
    );

    return text.join("");
  }

  const text = await getTextFromElement($.root()[0]);
  return text;
}

async function fetchTextFromUrl(url: string): Promise<string> {
  try {
    const response = await axios.get(url, {
      responseType: "text",
      validateStatus: null,
    });
    return await extractTextFromHtml(response.data);
  } catch (error) {
    throw new Error("Error fetching the URL: " + error.message);
  }
}

// main method
serve(async (req) => {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // input doc is passed in request payload
  const { text, url } = await req.json();

  let inputText: string;

  if (url) {
    inputText = await fetchTextFromUrl(url);
  } else {
    inputText = text;
  }
  console.log("inputText", inputText);

  // split the text:
  //   - first try by paragraphs
  //   - then by character length per sentence, max 250 char's
  const paragraphs = inputText.split(/\n\n+/).filter((str) => {
    // Check for null values
    if (str === null) {
      return false;
    }

    // Check for empty strings or whitespace-only strings
    if (str.trim() === "") {
      return false;
    }

    return true; // Include non-null, non-empty, non-whitespace strings
  });
  console.log("paragraphs", paragraphs);

  // for each paragraph & index, add paragraph if less than 250 characters
  let final_paragraphs: string[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    if (para.length <= 250) {
      final_paragraphs.push(para);
    } else {
      // stop execution of loop
      // restart paragraph splitting from here to be character-based
      break;
    }
  }
  console.log("final_paragraphs", final_paragraphs);

  // join unpushed paragraphs back together
  const remainingParagraphs = paragraphs.slice(final_paragraphs.length, paragraphs.length);
  const remainingText = remainingParagraphs.join("\n\n");
  console.log("remainingText", remainingText);
  // split remaining text by sentences
  const remainingSentences = remainingText.split(/(?<=[.?!])\s+(?=[a-z])/).filter((str) => {
    // Check for null values
    if (str === null) {
      return false;
    }

    // Check for empty strings or whitespace-only strings
    if (str.trim() === "") {
      return false;
    }

    return true; // Include non-null, non-empty, non-whitespace strings
  });

  // join groups of sentences up to 250 characters total and push as a 'paragraph'
  let sentenceGroup: string[] = [];
  for (let i = 0; i < remainingSentences.length; i++) {
    const sentence = remainingSentences[i];
    if (sentenceGroup.join(" ").length + sentence.length <= 250) {
      sentenceGroup.push(sentence);
    } else {
      // stop execution of loop
      // restart paragraph splitting from here to be character-based
      if (sentenceGroup.length > 0) {
        final_paragraphs.push(sentenceGroup.join(" "));
        sentenceGroup = [];
      }
    }
  }
  console.log("sentenceGroup", sentenceGroup);
  // if there are any remaining sentences, push them as a paragraph
  if (sentenceGroup.length > 0) {
    // join unpushed sentences back together
    const remainingSentencesString = remainingSentences
      .slice(sentenceGroup.length, remainingSentences.length)
      .join(" ");
    final_paragraphs.push(remainingSentencesString);
  }

  // for each sentence:
  //   1. get the embedding via open-ai
  //   2. insert into `parsed_final` table
  const configuration = new Configuration({ apiKey: Deno.env.get("OPENAI_API_KEY") });
  const openai = new OpenAIApi(configuration);

  // generate a uuid that corresponds to this original doc
  const doc_id = await v5.generate(uuid_namespace, inputText);
  console.log("doc_id", doc_id);

  for (let i = 0; i < final_paragraphs.length; i++) {
    console.log("final_paragraphs[i]", final_paragraphs[i]);
    const sentence = final_paragraphs[i];
    const response = await openai.createEmbedding({
      model: "text-embedding-ada-002",
      input: sentence,
    });
    const [{ embedding }] = response.data.data;
    const uuid = await v5.generate(doc_id, sentence);
    const { error } = await supabase
      .from("parsed_final")
      .insert({ id: uuid, content: sentence, embedding, original_doc_id: doc_id });
    if (error) {
      console.error(error);
    }
  }

  return new Response("ok", { headers: { "Content-Type": "application/json" } });
});
