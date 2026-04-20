interface NavLink {
  label: string;
  href: string;
  icon: string;
  external?: boolean;
}
interface Social {
  label: string;
  href: string;
  icon: string;
}

interface SiteConfig {
  name: string;
  shortName: string;
  url: string;
  description: string;
  defaultOgImage: string;
  locale: string;
  navLinks: readonly NavLink[];
  ctaButton: { label: string; href: string; icon: string };
  socials: readonly Social[];
  analytics: { umamiSrc: string; umamiWebsiteId: string };
}

export const SITE: SiteConfig = {
  name: 'David Furman',
  shortName: 'DF',
  url: 'https://david-furman.com',
  description:
    "David Furman's personal site, documenting work, projects, and contributions across cybersecurity, DevOps, gaming, and open source.",
  defaultOgImage: '/images/index-meta.png',
  locale: 'en',
  navLinks: [
    { label: 'Home', href: '/', icon: 'lucide:home' },
    { label: 'My Work', href: '/work', icon: 'lucide:briefcase' },
    { label: 'My Blog', href: 'https://blog.thefourcraft.com', icon: 'lucide:quote', external: true },
    { label: 'Opinions', href: '/opinions', icon: 'lucide:message-square-quote' },
    { label: 'Contact Me', href: '/contact', icon: 'lucide:phone' },
  ],
  ctaButton: {
    label: 'Investment',
    href: '/investments',
    icon: 'lucide:heart',
  },
  socials: [
    { label: 'GitHub', href: 'https://github.com/thefourcraft', icon: 'simple-icons:github' },
    { label: 'LinkedIn', href: 'https://www.linkedin.com/in/davidfurman', icon: 'simple-icons:linkedin' },
    { label: 'X', href: 'https://x.com/davidfurman', icon: 'simple-icons:x' },
  ],
  analytics: {
    umamiSrc: 'https://analytics.ims-network.net/script.js',
    umamiWebsiteId: 'eb95aa07-0a06-4aa6-931d-22ef79ee78cb',
  },
} as const satisfies SiteConfig;
