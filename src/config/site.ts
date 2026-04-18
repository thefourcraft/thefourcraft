interface NavLink {
  label: string;
  href: string;
  icon: string;
  external?: boolean;
}
interface FooterLink {
  label: string;
  href: string;
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
  footerLinks: readonly FooterLink[];
  socials: readonly Social[];
  analytics: { umamiSrc: string; umamiWebsiteId: string };
  thirdParty: {
    enableAccessibilityScript: string;
    hostagesTickerScript: string;
    hostagesTickerIntegrity: string;
  };
}

export const SITE: SiteConfig = {
  name: 'David Furman',
  shortName: 'DF',
  url: 'https://david-furman.com',
  description:
    "David Furman's personal site — documenting work, projects, and contributions across cybersecurity, DevOps, gaming, and open source.",
  defaultOgImage: '/images/index-meta.png',
  locale: 'en',
  navLinks: [
    { label: 'Home', href: '/', icon: 'lucide:home' },
    { label: 'My Work', href: '/work', icon: 'lucide:briefcase' },
    { label: 'My Blog', href: 'https://blog.thefourcraft.com', icon: 'lucide:quote', external: true },
    { label: 'Resume', href: '/resume', icon: 'lucide:paperclip' },
    { label: 'Contact Me', href: '/contact', icon: 'lucide:phone' },
  ],
  ctaButton: {
    label: 'Investment',
    href: '/investments',
    icon: 'lucide:heart',
  },
  footerLinks: [
    { label: 'Tools Platform', href: 'https://tools.david-furman.com' },
    { label: 'Blog', href: 'https://blog.david-furman.com' },
    { label: 'My Work', href: '/work' },
  ],
  socials: [
    { label: 'GitHub', href: 'https://github.com/thefourcraft', icon: 'simple-icons:github' },
    { label: 'LinkedIn', href: 'https://www.linkedin.com/in/davidfurman', icon: 'simple-icons:linkedin' },
    { label: 'X', href: 'https://x.com/davidfurman', icon: 'simple-icons:x' },
  ],
  analytics: {
    umamiSrc: 'https://analytics.ims-network.net/script.js',
    umamiWebsiteId: 'eb95aa07-0a06-4aa6-931d-22ef79ee78cb',
  },
  thirdParty: {
    enableAccessibilityScript:
      'https://cdn.enable.co.il/licenses/enable-L14970n18edgjtql-1022-37091/init.js',
    hostagesTickerScript: 'https://bringthemhomenow.net/1.0.8/hostages-ticker.js',
    hostagesTickerIntegrity:
      'sha384-jQVW0E+wZK5Rv1fyN+b89m7cYY8txH4s3uShzHf1T51hdBTPo7yKL6Yizgr+Gp8C',
  },
} as const satisfies SiteConfig;
