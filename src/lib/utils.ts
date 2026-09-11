import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge only knows the default font-size utilities. The project's
// semantic text scale (index.css --text-* tokens: caption/note/control/body/
// section/page/progress) is invisible to its font-size group, so a consumer
// class like text-section could never win against a primitive's text-lg —
// both survived and CSS source order (text-lg last) decided. Registering the
// scale makes twMerge treat them as competing font-size utilities: the
// consumer class wins, as the dialog title contract requires.
const twMergeSemantic = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "caption",
            "note",
            "control",
            "body",
            "section",
            "page",
            "progress",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMergeSemantic(clsx(inputs));
}

