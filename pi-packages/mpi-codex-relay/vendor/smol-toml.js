/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */function L(e,r){let i=e.slice(0,r).split(/\r?\n/);return[i.length,i.pop().length+1]}function V(e,r,i){let n=e.split(/\r?\n/),a="",s=(Math.log10(r+1)|0)+1;for(let l=r-1;l<=r+1;l++){let f=n[l-1];if(!f)continue;if(a+=l.toString().padEnd(s," "),a+=":  ",a+=f,a+=`
`,l===r)a+=" ".repeat(s+i+2),a+=`^
`}return a}class o extends Error{line;column;codeblock;constructor(e,r){let[i,n]=L(r.toml,r.ptr),a=V(r.toml,i,n);super(`Invalid TOML document: ${e}

${a}`,r);this.line=i,this.column=n,this.codeblock=a}static x(e,r,i){throw new o(e,{toml:r.s,ptr:i??r.p})}}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */function v(e){let r=e.p,i=e.s.charCodeAt(e.p++),n=i,a=i===39,s=i===e.s.charCodeAt(e.p)&&i===e.s.charCodeAt(e.p+1);if(s){if((i=e.s.charCodeAt(e.p+=2))===10)e.p++;else if(i===13&&e.s.charCodeAt(e.p+1)===10)e.p+=2}let l="",f=e.p,p=0;for(;e.p<e.s.length;e.p++)if(i=e.s.charCodeAt(e.p),s&&(i===10||i===13&&e.s.charCodeAt(e.p+1)===10))p=p&&3;else if(i<32&&i!==9||i===127)o.x("control characters are not allowed in strings",e);else if((!p||p===3)&&i===n&&(!s||e.s.charCodeAt(e.p+1)===n&&e.s.charCodeAt(e.p+2)===n)){if(s){if(e.s.charCodeAt(e.p+3)===n)e.p++;if(e.s.charCodeAt(e.p+3)===n)e.p++}if(!p){let t=e.s.slice(f,e.p);l=l?l+t:t}return e.p+=s?3:1,l}else if(!p){if(!a&&i===92)l+=e.s.slice(f,f=e.p),p=1}else if(p===1)if(i===120||i===117||i===85){let t=e.p++-1,u=0,d=i===120?2:i===117?4:8;for(let b=0;b<d;b++,e.p++){let A=e.s.charCodeAt(e.p),D=A>=48&&A<=57?A-48:A>=65&&A<=70?A-65+10:A>=97&&A<=102?A-97+10:-1;if(D<0)o.x("invalid non-hex character in unicode escape",e);u=u<<4|D}if(u<0||u>1114111||u>=55296&&u<=57343)o.x("invalid unicode escape",e,t);l+=String.fromCodePoint(u),f=e.p--,p=0}else if(s&&(i===32||i===9))p=2;else{if(i===98)l+="\b";else if(i===116)l+="\t";else if(i===110)l+=`
`;else if(i===102)l+="\f";else if(i===114)l+="\r";else if(i===101)l+="\x1B";else if(i===34)l+='"';else if(i===92)l+="\\";else o.x("unrecognised escape sequence",e);f=e.p+1,p=0}else if(i!==32&&i!==9){if(p===2)o.x("invalid escape: only line-ending whitespace may be escaped",e,f);p=!a&&i===92?1:0,f=e.p}o.x("unfinished string",e,r)}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */var B=/^(\d{4}-\d{2}-\d{2})?[Tt ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|z|[-+]\d{2}:\d{2})?$/i;class g extends Date{#r=!1;#i=!1;#e=null;constructor(e,r,i){let n=!0,a=!0,s="Z",l;if(typeof e==="string")if(r)e:{if(r<3){if(+e.slice(11,13)>23){e="";break e}if(r===2)s=null,e+="Z";else if((l=e.charCodeAt(e.length-1))!==90&&l!==122)s=e.slice(e.length-6);if(i)e=e.slice(0,10)+"T"+e.slice(11)}else if(r===4)e=+e.slice(0,2)>23?"":`0000-01-01T${e}Z`;n=r!==4,a=r!==3}else{let f=e.match(B);if(f){if(!f[1])n=!1,e=`0000-01-01T${e}`;if(a=!!f[2],a&&e[10]===" "&&(e=e.replace(" ","T")),f[2]&&+f[2]>23)e="";else if(s=f[3]||null,!s&&a)e+="Z"}else e=""}super(e);if(!isNaN(this.getTime()))this.#r=n,this.#i=a,this.#e=s}isDateTime(){return this.#r&&this.#i}isLocal(){return!this.#r||!this.#i||!this.#e}isDate(){return this.#r&&!this.#i}isTime(){return this.#i&&!this.#r}isValid(){return this.#r||this.#i}toISOString(){let e=super.toISOString();if(this.isDate())return e.slice(0,10);if(this.isTime())return e.slice(11,23);if(this.#e===null)return e.slice(0,-1);if(this.#e==="Z"||this.#e==="z")return e;let r=+this.#e.slice(1,3)*60+ +this.#e.slice(4,6);return r=this.#e[0]==="-"?r:-r,new Date(this.getTime()-r*60000).toISOString().slice(0,-1)+this.#e}static wrapAsOffsetDateTime(e,r="Z"){let i=new g(e);return i.#e=r,i}static wrapAsLocalDateTime(e){let r=new g(e);return r.#e=null,r}static wrapAsLocalDate(e){let r=new g(e);return r.#i=!1,r.#e=null,r}static wrapAsLocalTime(e){let r=new g(e);return r.#r=!1,r.#e=null,r}}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */function h(e,r=10){return r===16?e>47&&e<58||e>64&&e<71||e>96&&e<103:e>47&&e<48+r}function O(e,r){return e===32||e===9||e===10||e===13||r&&(e===r||e===44)||e===35}function w(e,r){let i=e.p,n=e.s.charCodeAt(e.p);if(n===91||n===123){e.d--||o.x("document contains excessively nested structures. aborting.",e);let a=n===91?S(e):I(e);return e.d++,a}if(n===34||n===39)return v(e);if(n===116){if(e.s.charCodeAt(++e.p)!==114||e.s.charCodeAt(++e.p)!==117||e.s.charCodeAt(++e.p)!==101)o.x("invalid value",e,i);return e.p++,!0}if(n===102){if(e.s.charCodeAt(++e.p)!==97||e.s.charCodeAt(++e.p)!==108||e.s.charCodeAt(++e.p)!==115||e.s.charCodeAt(++e.p)!==101)o.x("invalid value",e,i);return e.p++,!1}if(n===43||n===45)return T(e,e.p,e.s.charCodeAt(++e.p),44-n,r);if(e.s.charCodeAt(e.p+4)===45&&e.s.charCodeAt(e.p+7)===45)return Z(e,n,r);if(e.s.charCodeAt(e.p+2)===58)return N(e,n,r);return T(e,e.p,n,0,r)}function T(e,r,i,n,a){let s=i,l=0,f=!1;if(s===105){if(e.s.charCodeAt(++e.p)!==110||e.s.charCodeAt(++e.p)!==102)o.x("invalid value",e,r);return e.p++,(n||1)/0}if(s===110){if(e.s.charCodeAt(++e.p)!==97||e.s.charCodeAt(++e.p)!==110)o.x("invalid value",e,r);return e.p++,NaN}if(s===48){if(++e.p>=e.s.length||O(s=e.s.charCodeAt(e.p),a))return e.bi===!0?0n:0;if(!n){if(s===120)return y(e,r,16,a);else if(s===98)return y(e,r,2,a);else if(s===111)return y(e,r,8,a)}if(s===46)l=2;else if(s===101||s===69)l=4;else o.x("illegal leading zero",e,r)}else if(!h(s))o.x("invalid value",e,r);while(++e.p<e.s.length&&(s=e.s.charCodeAt(e.p),!O(s,a))){if(!l)l=1;if(s===95){if(!(l&1))o.x("illegal underscore",e);l+=11,f=!0}else if(l===1&&s===46)l=2;else if((l===1||l===3)&&(s===101||s===69))l=4;else if(l===4&&(s===43||s===45))l=6;else if(!h(s))o.x("illegal character in numeric literal",e);else if(l>9)l-=11;else if(!(l&1))l++}if(!l){let t=(i-48)*(n||1);return e.bi===!0?BigInt(t):t}if(!(l&1))o.x("unfinished numeric value",e,r);let p=e.s.slice(r,e.p);if(f)p=p.replaceAll("_","");return l>1?parseFloat(p):j(e,p,10,r)}function y(e,r,i,n){let a,s=1;while(++e.p<e.s.length&&(a=e.s.charCodeAt(e.p),!O(a,n)))if(a===95){if(s&1)o.x("illegal underscore",e);s=3}else if(!h(a,i))o.x("illegal character in numeric literal",e);else if(s&1)s--;if(s&1)o.x("unfinished numeric value",e);let l=e.s.slice(r+2,e.p);if(s)l=l.replaceAll("_","");return j(e,l,i,r)}function j(e,r,i,n){if(e.bi!==!0)e:{let a=parseInt(r,i);if(!Number.isSafeInteger(a)){if(e.bi)break e;o.x("integer value cannot be represented losslessly",e,n)}return a}return i===10?BigInt(r):BigInt((i===2?"0b":i===8?"0o":"0x")+r)}function Z(e,r,i){let n=e.p++,a;if(!h(r)||!h(e.s.charCodeAt(e.p++))||!h(e.s.charCodeAt(e.p++))||!h(e.s.charCodeAt(e.p++)))return T(e,e.p=n,r,0,i);if(e.p+=5,!h(e.s.charCodeAt(e.p++)))o.x("invalid date-time: date part is malformed",e,n);if(e.p>=e.s.length||((r=e.s.charCodeAt(e.p))!==32||(a=!0,!h(e.s.charCodeAt(e.p+1))))&&r!==84&&r!==116){let l=e.s.slice(n,e.p);return C(e,l,3,!1,n)}if(e.s.charCodeAt(e.p+=3)!==58)o.x("invalid date-time: time part is malformed",e,n);if(e.s.charCodeAt(e.p+=3)===58)e.p+=3;if(e.s.charCodeAt(e.p)===46)while(h(e.s.charCodeAt(++e.p)));if(r=e.s.charCodeAt(e.p)){if(r===90||r===122){let l=e.s.slice(n,++e.p);return C(e,l,1,a,n,"[+00:00]")}if(r===43||r===45){let l=e.s.slice(n,e.p+=6);return C(e,l,1,a,n,!e.ld&&"["+e.s.slice(e.p-6,e.p)+"]")}}let s=e.s.slice(n,e.p);return C(e,s,2,a,n)}function N(e,r,i){let n=e.p;if(!h(r)||!h(e.s.charCodeAt(++e.p)))return T(e,--e.p,r,0,i);if(e.s.charCodeAt(e.p+=4)===58)e.p+=3;if(e.s.charCodeAt(e.p)===46)while(h(e.s.charCodeAt(++e.p)));let a=e.s.slice(n,e.p);return C(e,a,4,!1,n)}function C(e,r,i,n,a,s){if(e.ld){let l=new g(r,i,n);if(!l.isValid())o.x("invalid date",e,a);return l}try{if(s)r+=s;switch(i){case 1:return Temporal.ZonedDateTime.from(r);case 2:return Temporal.PlainDateTime.from(r);case 3:return Temporal.PlainDate.from(r);case 4:return Temporal.PlainTime.from(r)}}catch(l){o.x(l instanceof Error?l.message:""+l,e,a)}}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */function P(e){for(;e.p<e.s.length;e.p++){let r=e.s.charCodeAt(e.p);if(r===10)break;if(r===13&&e.s.charCodeAt(e.p+1)===10){e.p++;break}if(r<32&&r!==9||r===127)o.x("control characters are not allowed in comments",e)}}function m(e,r,i){let n;while(e.p<e.s.length){while(e.p<e.s.length&&((n=e.s.charCodeAt(e.p))===32||n===9||!r&&(n===10||n===13&&e.s.charCodeAt(e.p+1)===10)))e.p++;if(i||n!==35)break;P(e)}}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */function k(e,r=61){let i,n=0,a=[],s,l=e.s.charCodeAt(i=e.p);do if(l===r){if(!n)o.x("unexpected end of key",e);if(n===1)a.push(e.s.slice(s,e.p));return e.p++,a}else if(l===46){if(!n)o.x("illegal empty bare key",e);if(n===1)a.push(e.s.slice(s,e.p));n=0}else if(!n&&(l===34||l===39)){if(l===e.s.charCodeAt(e.p+1)&&l===e.s.charCodeAt(e.p+2))o.x("illegal quoted key: multiline strings are not allowed",e);a.push(v(e)),n=2,e.p--}else if(l===32||l===9){if(n===1)a.push(e.s.slice(s,e.p)),n=2}else if(n===2||l<48&&l!==45||l>57&&l<65||l>90&&l<97&&l!==95||l>122)o.x("illegal character in key",e);else if(!n)n=1,s=e.p;while(l=e.s.charCodeAt(++e.p));o.x("incomplete key-value: cannot find end of key",e,i)}function I(e){let r=e.p++,i=Object.create(null),n=new Set,a;while(e.p<e.s.length){if(m(e),(a=e.s.charCodeAt(e.p))===125)return e.p++,i;let s,l=i,f=!1,p=e.p,t=k(e);for(let d=0;d<t.length;d++){if(d)l=f?l[s]:l[s]=Object.create(null);if(s=t[d],(f=Object.hasOwn(l,s))&&(typeof l[s]!=="object"||n.has(l[s])))o.x("trying to redefine an already defined value",e,p);let b=s==="__proto__";if(e.uk&&(b||s==="constructor")){l=e.uk!==1&&o.x("document contains an unsafe property",e,p);break}if(!f&&b)Object.defineProperty(l,s,{enumerable:!0,configurable:!0,writable:!0})}if(f)o.x("trying to redefine an already defined value",e,p);m(e,!0,!0);let u=w(e,125);if(l&&typeof(l[s]=u)==="object")n.add(u);if(m(e),(a=e.s.charCodeAt(e.p++))===125)return i;if(a!==44)o.x("expected comma or end of structure",e,e.p-1)}o.x("unfinished table",e,r)}function S(e){let r=e.p++,i=[],n;while(e.p<e.s.length){if(m(e),(n=e.s.charCodeAt(e.p))===93)return e.p++,i;if(i.push(w(e,93)),m(e),(n=e.s.charCodeAt(e.p++))===93)return i;if(n!==44)o.x("expected comma or end of structure",e,e.p-1)}o.x("unfinished array",e,r)}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */function E(e,r,i,n,a){let s=i,l=n,f,p=!1,t;for(let u=0;u<r.length;u++){if(u){if(s=p?s[f]:s[f]=Object.create(null),l=(t=l[f]).c,a===0&&(t.t===1||t.t===2))return null;if(t.t===2){let d=s.length-1;s=s[d],l=l[d].c}}if(f=r[u],(p=Object.hasOwn(s,f))&&l[f]?.t===0&&l[f]?.d)return null;if(!p){let d=f==="__proto__";if(e.uk&&(d||f==="constructor"))return!1;if(d)Object.defineProperty(s,f,{enumerable:!0,configurable:!0,writable:!0}),Object.defineProperty(l,f,{enumerable:!0,configurable:!0,writable:!0});l[f]={t:u<r.length-1&&a===2?3:a,d:!1,i:0,c:Object.create(null)}}}if(t=l[f],t.t!==a&&!(a===1&&t.t===3))return null;if(a===2){if(!t.d)t.d=!0,s[f]=[];s[f].push(s=Object.create(null)),t.c[t.i++]=t={t:1,d:!1,i:0,c:Object.create(null)}}if(t.d)return null;if(t.d=!0,a===1)s=p?s[f]:s[f]=Object.create(null);else if(a===0&&p)return null;return[f,s,t.c]}function _(e,r,i){if(r===null||e.uk===2)o.x(r===null?"trying to redefine an already defined table or value":"document contains an unsafe property",e,i)}function se(e,r={}){let i={s:e,p:0,d:r.maxDepth??1000,bi:r.integersAsBigInt??!1,ld:r.useLegacyDate??!0,uk:r.unsafeKeyBehaviour==="throw"?2:r.unsafeKeyBehaviour==="drop"?1:0},n=Object.create(null),a=Object.create(null),s,l=!1,f=n,p=a;if(e.charCodeAt(0)===65279)i.p++;m(i);while(i.p<e.length){if(e.charCodeAt(i.p)===91){let t=e.charCodeAt(++i.p)===91;s=i.p+=+t,l=!1;let u=k(i,93);if(t){if(e.charCodeAt(i.p)!==93)o.x("expected end of table array declaration",i);i.p++}let d=E(i,u,n,a,t?2:1);if(!d)_(i,d,s),l=!0;else p=d[2],f=d[1]}else{s=i.p;let t=k(i),u=E(i,t,f,p,0);if(!u&&!l)_(i,u,s);m(i,!0,!0);let d=w(i,void 0);if(u&&!l)u[1][u[0]]=d}if(m(i,!0),i.p<e.length&&(s=e.charCodeAt(i.p))!==10&&(s!==13||e.charCodeAt(i.p+1)!==10))o.x("each key-value declaration must be followed by an end-of-line",i);m(i)}return n}export{se as parse};
