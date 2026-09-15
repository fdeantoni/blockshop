/**
 * Profile icons that have no emoji. A profile stores the token (`icon:<name>`) instead of an emoji; the editor
 * draws the SVG wherever it would print the emoji. Nothing outside the editor shows profile icons.
 */
export interface CustomIcon {
  label: string;
  svg: string;
}

export const CUSTOM_ICONS: Record<string, CustomIcon> = {
  "icon:capybara": {
    label: "Capybara",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<ellipse cx="19" cy="15.5" rx="4.6" ry="5.2" fill="#6f4529" transform="rotate(-15 19 15.5)"/>
<ellipse cx="45" cy="15.5" rx="4.6" ry="5.2" fill="#6f4529" transform="rotate(15 45 15.5)"/>
<ellipse cx="19.3" cy="16.2" rx="2.3" ry="2.8" fill="#4a2c19" transform="rotate(-15 19.3 16.2)"/>
<ellipse cx="44.7" cy="16.2" rx="2.3" ry="2.8" fill="#4a2c19" transform="rotate(15 44.7 16.2)"/>
<path d="M32 12C44 12 50 17 51 27C52 34 53 40 53 46C53 55 45 60 32 60C19 60 11 55 11 46C11 40 12 34 13 27C14 17 20 12 32 12Z" fill="#ad7a4f"/>
<ellipse cx="15.5" cy="34" rx="3.2" ry="2.2" fill="#e79a86" opacity="0.55"/>
<ellipse cx="48.5" cy="34" rx="3.2" ry="2.2" fill="#e79a86" opacity="0.55"/>
<path d="M22 33H42C47 33 49 37 49 42V50C49 56 43 59.5 32 59.5C21 59.5 15 56 15 50V42C15 37 17 33 22 33Z" fill="#8a5c39"/>
<ellipse cx="25.8" cy="38.8" rx="2.6" ry="1.5" fill="#2f1b0f" transform="rotate(-8 25.8 38.8)"/>
<ellipse cx="38.2" cy="38.8" rx="2.6" ry="1.5" fill="#2f1b0f" transform="rotate(8 38.2 38.8)"/>
<path d="M32 43.5V47.5M28.3 49.6Q32 52.6 35.7 49.6" stroke="#2f1b0f" stroke-width="1.7" fill="none" stroke-linecap="round"/>
<path d="M18.8 25A3.2 3.2 0 0 0 25.2 25Z" fill="#24150c"/>
<path d="M38.8 25A3.2 3.2 0 0 0 45.2 25Z" fill="#24150c"/>
<path d="M18.2 25.4Q22 23.6 25.8 25.4M38.2 25.4Q42 23.6 45.8 25.4" stroke="#6f4529" stroke-width="1.6" fill="none" stroke-linecap="round"/>
<circle cx="32" cy="9.5" r="6.5" fill="#f7931e"/>
<circle cx="30" cy="7.6" r="1.8" fill="#ffc166"/>
<path d="M32 3.4q3.3-2.8 7-1.1q-2.8 3.5-7 1.1z" fill="#3f9b4b"/>
</svg>`,
  },
};

export const customIconUrl = (icon: CustomIcon): string => `data:image/svg+xml,${encodeURIComponent(icon.svg)}`;

/** A profile icon as a DOM node: an emoji as text, a custom icon as an image the size of an emoji. */
export function iconNode(icon: string): Node {
  const custom = CUSTOM_ICONS[icon];
  if (!custom) return document.createTextNode(icon);
  const img = document.createElement("img");
  img.className = "ico";
  img.src = customIconUrl(custom);
  img.alt = custom.label;
  img.draggable = false;
  return img;
}
