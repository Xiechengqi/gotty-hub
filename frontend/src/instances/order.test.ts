import {expect,it} from 'vitest';
import {normalizeOrder,reorderInstance} from './order';
it('uses one canonical order for sidebar and the open-tab subset',()=>{
 const full=['one','closed','two','three'],opened=new Set(['one','two','three']);
 const fromTabs=reorderInstance(full,'three','one');
 expect(fromTabs).toEqual(['three','one','closed','two']);
 expect(fromTabs.filter(id=>opened.has(id))).toEqual(['three','one','two']);
 const fromSidebar=reorderInstance(fromTabs,'one','two');
 expect(fromSidebar).toEqual(['three','closed','two','one']);
 expect(fromSidebar.filter(id=>opened.has(id))).toEqual(['three','two','one']);
});
it('retains saved order through SSE refreshes, appends new instances, and drops revoked or duplicate IDs',()=>{
 expect(normalizeOrder(['two','removed','two',null,'one'],['one','two','new'])).toEqual(['two','one','new']);
 expect(normalizeOrder(null,['one','two'])).toEqual(['one','two']);
 expect(reorderInstance(['one','two'],'foreign','two')).toEqual(['one','two']);
});
