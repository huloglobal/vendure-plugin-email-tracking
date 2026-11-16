import { describe, expect, it } from 'vitest';
import { suppressionFilter } from './http-helpers';

describe('suppressionFilter (0.18.0)', () => {
    it('default-channel admins: no filter, or the search only', () => {
        expect(suppressionFilter('', null)).toEqual({ where: '', params: [] });
        expect(suppressionFilter('a_b%', null)).toEqual({ where: ' WHERE recipient LIKE ?', params: ['%a\\_b\\%%'] });
    });
    it('a channel admin only ever sees their channel', () => {
        expect(suppressionFilter('', 3)).toEqual({ where: ' WHERE `channelId` = ?', params: [3] });
        expect(suppressionFilter('jane', 3)).toEqual({ where: ' WHERE recipient LIKE ? AND `channelId` = ?', params: ['%jane%', 3] });
    });
});
