import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const opinions = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/opinions' }),
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    publishDate: z.coerce.date(),
    draft: z.boolean().optional().default(false),
  }),
});

export const collections = { opinions };
