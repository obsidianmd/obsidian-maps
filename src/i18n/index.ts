import { moment } from 'obsidian';
import { en, TranslationDictionary, TranslationKey } from './locales/en';
import { zhCN } from './locales/zh-cn';
import { zhTW } from './locales/zh-tw';

export type SupportedLocale = 'en' | 'zh-CN' | 'zh-TW';
type TranslationVariables = Record<string, string | number>;

const translations: Record<SupportedLocale, Partial<TranslationDictionary>> = {
	en,
	'zh-CN': zhCN,
	'zh-TW': zhTW,
};

export function resolveLocale(locale: string): SupportedLocale {
	const normalizedLocale = locale.toLowerCase().replace(/_/g, '-');

	if (normalizedLocale === 'zh' ||
		normalizedLocale.startsWith('zh-cn') ||
		normalizedLocale.startsWith('zh-sg') ||
		normalizedLocale.includes('hans')) {
		return 'zh-CN';
	}

	if (normalizedLocale.startsWith('zh-tw') ||
		normalizedLocale.startsWith('zh-hk') ||
		normalizedLocale.startsWith('zh-mo') ||
		normalizedLocale.includes('hant')) {
		return 'zh-TW';
	}

	return 'en';
}

export function getLocale(): SupportedLocale {
	return resolveLocale(moment.locale());
}

export function t(key: TranslationKey, variables: TranslationVariables = {}): string {
	const message = translations[getLocale()][key] ?? en[key];

	return message.replace(/\{\{(\w+)\}\}/g, (placeholder, variableName: string) => {
		const value = variables[variableName];
		return value === undefined ? placeholder : String(value);
	});
}
