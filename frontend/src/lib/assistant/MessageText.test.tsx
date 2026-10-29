import {render, screen} from '@testing-library/react'
import {MessageText, splitBlocks} from './MessageText'

describe('MessageText', () => {
  it('splits fenced code from the text around it', () => {
    expect(splitBlocks('Run this:\n```bash\ndf -h\n```\nthen look.')).toEqual([
      {code: false, text: 'Run this:\n'}, {code: true, lang: 'bash', text: 'df -h'}, {code: false, text: '\nthen look.'},
    ])
    expect(splitBlocks('no code here')).toEqual([{code: false, text: 'no code here'}])
    expect(splitBlocks('```\nunfinished')).toEqual([{code: true, text: 'unfinished', lang: undefined}])
  })

  it('shows code in a block with a Copy button and inline code in a span', () => {
    render(<MessageText text={'Use `du -sh` here:\n```\ndu -xh /var | sort -h\n```'} />)
    expect(screen.getByText('du -sh').tagName).toBe('CODE')
    expect(screen.getByText('du -xh /var | sort -h').closest('pre')).not.toBeNull()
    expect(screen.getByRole('button', {name: 'Copy code'})).toBeInTheDocument()
  })

  it('never turns an answer into markup', () => {
    const {container} = render(<MessageText text={'<img src=x onerror=alert(1)> and <b>bold</b>'} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container).toHaveTextContent('<img src=x onerror=alert(1)>')
  })
})
