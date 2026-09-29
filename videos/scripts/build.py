import json,subprocess,os
A=12.0;AFTER=45.0;D=A+AFTER
IMPACT={'fable':19.762,'opus':14.283,'s5':7.709,'s55':6.076}
T=[('fable','Claude Fable 5.1','effort medium','41 min','13.8M tokens (173K out)','$14.41'),
   ('opus','Claude Opus 5.5','effort medium','72 min','40.3M tokens (260K out)','$14.90'),
   ('s5','Claude Sonnet 5','effort high','38 min','40.7M tokens (157K out)','$10.27'),
   ('s55','Claude Sonnet 5.5','effort high','38 min','29.7M tokens (216K out)','$8.77')]
for k,*_ in T:
    d=json.load(open(f'frames_{k}.json'));fr=d['frames'];L=d['L']/1000
    t0=L+IMPACT[k]-A;t1=t0+D
    fr=[f for f in fr if f['t']/1000<=t1]
    # frame active from its t until next
    lines=[]
    prev=None
    items=[(max(f['t']/1000,t0),f['name']) for f in fr if True]
    # drop frames before t0 except last one
    pre=[i for i in items if i[0]<=t0];post=[i for i in items if i[0]>t0]
    seq=([pre[-1]] if pre else [])+post
    for i,(t,n) in enumerate(seq):
        te=seq[i+1][0] if i+1<len(seq) else t1
        ts=max(t,t0)
        if te-ts<=0: continue
        lines.append(f"file '{n}'\nduration {te-ts:.5f}")
    lines.append(f"file '{seq[-1][1]}'")
    open(f'list_{k}.txt','w').write('\n'.join(lines))
    subprocess.run(['ffmpeg','-y','-loglevel','error','-f','concat','-safe','0','-i',f'list_{k}.txt','-vf','fps=30,scale=1280:720:flags=lanczos','-t',str(D),'-c:v','libx264','-crf','16','-preset','medium','-pix_fmt','yuv420p',f'tile_{k}.mp4'],check=True)
    print(k,'ok')
# compose
W,H=1280,720;FH=120;TOP=90
inputs=[];fc=[]
for i,(k,*_) in enumerate(T):
    inputs+=['-i',f'tile_{k}.mp4']
fc.append(f"color=c=0x0d1117:s=2560x{TOP+2*(H+FH)}:r=30:d={D}[bg]")
prev='bg'
for i,(k,name,eff,tm,tok,cost) in enumerate(T):
    x=(i%2)*W;y=TOP+(i//2)*(H+FH)
    fc.append(f"[{prev}][{i}:v]overlay={x}:{y}[o{i}]");prev=f'o{i}'
    ty=y+H
    fc.append(f"[{prev}]drawbox=x={x}:y={ty}:w={W}:h={FH}:color=0x161b22:t=fill,"
      f"drawtext=fontfile=arialbd.ttf:text='{name}':x={x+28}:y={ty+18}:fontsize=42:fontcolor=white,"
      f"drawtext=fontfile=arial.ttf:text='{eff}':x={x+28+ (len(name)*24)+30}:y={ty+26}:fontsize=32:fontcolor=0x58a6ff,"
      f"drawtext=fontfile=arial.ttf:text='Time {tm}  -  {tok}  -  {cost}':x={x+28}:y={ty+72}:fontsize=32:fontcolor=0xc9d1d9,"
      f"drawtext=fontfile=arialbd.ttf:text='Impact in %{{eif\:ceil({A}-t)\:d}}s':x={x+W-330}:y={ty+22}:fontsize=42:fontcolor=0xf0b429:enable='lt(t\,{A})',"
      f"drawtext=fontfile=arialbd.ttf:text='Impact +%{{eif\:floor(t-{A})\:d}}s':x={x+W-330}:y={ty+22}:fontsize=42:fontcolor=0xff6b6b:enable='gte(t\,{A})'[p{i}]")
    prev=f'p{i}'
fc.append(f"[{prev}]drawtext=fontfile=arialbd.ttf:text='One prompt, four models, one pass each  -  identical scenario - Severe wave + Seawall placed at the same click, default camera':x=(w-text_w)/2:y=16:fontsize=36:fontcolor=white,"
          f"drawtext=fontfile=arial.ttf:text='Footer = what each model spent to BUILD the app in one shot (Claude Code)  -  synced at the moment the flood reaches the shore':x=(w-text_w)/2:y=58:fontsize=22:fontcolor=0x8b949e[out]")
open('fc.txt','w').write(';\n'.join(fc))
subprocess.run(['ffmpeg','-y','-loglevel','error',*inputs,'-filter_complex_script','fc.txt','-map','[out]','-c:v','libx264','-crf','18','-preset','medium','-pix_fmt','yuv420p','../wave_bench_comparison.mp4'],check=True)
print('done')
