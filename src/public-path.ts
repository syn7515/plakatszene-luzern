// A file in public/, by its path from there ('/posters/x.svg'), wherever the
// site is served from: the root in development, /experiments/1/ once built
// (vite.config.ts's base). HTML and CSS get this from Vite; strings that
// only script reads need it here.
export const publicPath = (path: string) => import.meta.env.BASE_URL + path.replace(/^\//, '');
